#!/usr/bin/env node
// Claude Code hook entry for content-free activity reporting (task #110).
//
// Invariants:
// - ALWAYS exits 0. Exit code 2 blocks PreToolUse/UserPromptSubmit/Stop, and
//   any non-zero is noise — reporting loss must degrade silently and never
//   perturb the user's session. Declared async:true in hooks.json on top.
// - Content-free: builds the event via the activity allowlist; never reads
//   tool_input / tool_response / prompt / transcript_path.
// - Endpoint discovery via a file the plugin process writes (the hook cannot
//   see the plugin's env): $CLAUDE_PLUGIN_DATA/activity-endpoint-<ppid>.json,
//   falling back to <tmpdir>/raft-channel-activity-<ppid>.json. Both the
//   plugin MCP server and this hook are children of the same Claude Code
//   process, so ppid is the shared session key.

import { readFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildActivityEvent, buildSessionStartOutput } from "./activity.js";

const POST_TIMEOUT_MS = 2500;
const STDIN_TIMEOUT_MS = 3000;

export function discoveryFilePaths(env: NodeJS.ProcessEnv, ppid: number): string[] {
  const names: string[] = [];
  if (env.CLAUDE_PLUGIN_DATA) {
    names.push(path.join(env.CLAUDE_PLUGIN_DATA, `activity-endpoint-${ppid}.json`));
  }
  names.push(path.join(tmpdir(), `raft-channel-activity-${ppid}.json`));
  return names;
}

interface DiscoveredEndpoint {
  endpoint: string;
  token: string;
}

function readDiscovery(env: NodeJS.ProcessEnv, ppid: number): DiscoveredEndpoint | null {
  for (const file of discoveryFilePaths(env, ppid)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<DiscoveredEndpoint>;
      if (typeof raw.endpoint === "string" && typeof raw.token === "string") {
        return { endpoint: raw.endpoint, token: raw.token };
      }
    } catch {
      // try next location
    }
  }
  return null;
}

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
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

function post(target: DiscoveredEndpoint, body: string): Promise<void> {
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
            "x-raft-bridge-token": target.token,
          },
          timeout: POST_TIMEOUT_MS,
        },
        (res) => {
          res.resume();
          res.once("end", resolve);
          res.once("error", () => resolve());
        },
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

async function main(): Promise<void> {
  const input = await readStdin(STDIN_TIMEOUT_MS);
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return;
  }
  const sessionStartOutput = buildSessionStartOutput(payload);
  if (sessionStartOutput) {
    process.stdout.write(sessionStartOutput + "\n");
  }
  const event = buildActivityEvent(payload);
  if (!event) return;
  const target = readDiscovery(process.env, process.ppid);
  if (!target) return;
  await post(target, JSON.stringify(event));
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0));
