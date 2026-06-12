#!/usr/bin/env node

// src/activity-hook.ts
import { readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// src/activity.ts
import { randomUUID } from "node:crypto";
var ACTIVITY_EVENT_SCHEMA = "raft-activity.v1";
var V0_HOOK_EVENTS = /* @__PURE__ */ new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd"
]);
var CONTENT_CAP = 4096;
var SAFE_SCALAR = /^[a-zA-Z0-9._:@/ -]+$/;
var MAX_SCALAR_LENGTH = 120;
function safeScalar(value) {
  if (typeof value !== "string" || value.length === 0) return void 0;
  if (value.length > MAX_SCALAR_LENGTH) return void 0;
  if (!SAFE_SCALAR.test(value)) return void 0;
  return value;
}
function contentString(value) {
  if (value === void 0 || value === null) return void 0;
  let text;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return void 0;
    }
  }
  if (text.length === 0) return void 0;
  if (text.length > CONTENT_CAP) {
    return { text: text.slice(0, CONTENT_CAP), truncated: true };
  }
  return { text, truncated: false };
}
function buildActivityEvent(payload, now = () => /* @__PURE__ */ new Date()) {
  if (!payload || typeof payload !== "object") return null;
  const raw = payload;
  const hookEventName = safeScalar(raw.hook_event_name);
  if (!hookEventName || !V0_HOOK_EVENTS.has(hookEventName)) return null;
  const sessionId = safeScalar(raw.session_id) ?? "unknown";
  const toolName = safeScalar(raw.tool_name);
  const isError = hookEventName === "PostToolUseFailure";
  const event = {
    schema: ACTIVITY_EVENT_SCHEMA,
    eventId: randomUUID(),
    sessionId,
    hookEventName,
    status: isError ? "error" : "ok",
    occurredAt: now().toISOString()
  };
  if (toolName) event.toolName = toolName;
  let truncated = false;
  const isToolEvent = hookEventName === "PreToolUse" || hookEventName === "PostToolUse" || isError;
  if (isToolEvent) {
    const input = contentString(raw.tool_input);
    if (input) {
      event.toolInput = input.text;
      truncated ||= input.truncated;
    }
    const output = contentString(isError ? raw.error : raw.tool_output);
    if (output) {
      event.toolOutput = output.text;
      truncated ||= output.truncated;
    }
  }
  if (truncated) event.truncated = true;
  if (isError) event.errorClass = "tool_failure";
  return event;
}

// src/activity-hook.ts
var POST_TIMEOUT_MS = 2500;
var STDIN_TIMEOUT_MS = 3e3;
function discoveryFilePaths(env, ppid) {
  const names = [];
  if (env.CLAUDE_PLUGIN_DATA) {
    names.push(path.join(env.CLAUDE_PLUGIN_DATA, `activity-endpoint-${ppid}.json`));
  }
  names.push(path.join(tmpdir(), `raft-channel-activity-${ppid}.json`));
  return names;
}
function readDiscovery(env, ppid) {
  for (const file of discoveryFilePaths(env, ppid)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (typeof raw.endpoint === "string" && typeof raw.token === "string") {
        return { endpoint: raw.endpoint, token: raw.token };
      }
    } catch {
    }
  }
  return null;
}
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString("utf8")), timeoutMs);
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.once("error", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
function post(target, body) {
  return new Promise((resolve) => {
    try {
      const url = new URL(target.endpoint);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "x-raft-bridge-token": target.token
          },
          timeout: POST_TIMEOUT_MS
        },
        (res) => {
          res.resume();
          res.once("end", resolve);
          res.once("error", () => resolve());
        }
      );
      req.once("timeout", () => {
        req.destroy();
        resolve();
      });
      req.once("error", () => resolve());
      req.end(body);
    } catch {
      resolve();
    }
  });
}
async function main() {
  const input = await readStdin(STDIN_TIMEOUT_MS);
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  const event = buildActivityEvent(payload);
  if (!event) return;
  const target = readDiscovery(process.env, process.ppid);
  if (!target) return;
  await post(target, JSON.stringify(event));
}
main().catch(() => void 0).finally(() => process.exit(0));
export {
  discoveryFilePaths
};
