import http from "node:http";
import { randomUUID } from "node:crypto";

export interface WakeRequest {
  schema: "slock-claude-code-channel-wake.v1";
  attemptId: string;
  eventId: string;
  messageId: string;
  agentId: string;
  profile: string;
  coreSessionId: string;
  adapterInstance: string;
  occurredAt: string;
}

export interface WakeResponse {
  ok: boolean;
  runtimeSession?: string;
  failureClass?: "no_session" | "busy" | "injection_failed" | "protocol_mismatch" | "auth_revoked";
  reason?: string;
  retryAfterMs?: number;
}

export interface ChannelNotifier {
  notify(request: WakeRequest): Promise<void>;
}

export interface WakeServerOptions {
  host: string;
  port: number;
  token?: string;
  runtimeSession?: string;
  notifier: ChannelNotifier;
}

export interface StartedWakeServer {
  url: string;
  runtimeSession: string;
  close(): Promise<void>;
}

export async function startWakeServer(options: WakeServerOptions): Promise<StartedWakeServer> {
  const runtimeSession = options.runtimeSession ?? `claude_${randomUUID()}`;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/wake") {
      writeJson(res, 404, {
        ok: false,
        failureClass: "no_session",
        reason: "Unknown Slock Claude channel endpoint",
      });
      return;
    }
    if (options.token && req.headers["x-slock-bridge-token"] !== options.token) {
      writeJson(res, 401, {
        ok: false,
        failureClass: "auth_revoked",
        reason: "Invalid Slock bridge token",
      });
      return;
    }

    let body: WakeRequest;
    try {
      body = validateWakeRequest(JSON.parse(await readBody(req)));
    } catch (err) {
      writeJson(res, 400, {
        ok: false,
        failureClass: "protocol_mismatch",
        reason: err instanceof Error ? err.message : "Invalid wake request",
      });
      return;
    }

    try {
      await options.notifier.notify(body);
      writeJson(res, 200, { ok: true, runtimeSession });
    } catch (err) {
      writeJson(res, 500, {
        ok: false,
        failureClass: "injection_failed",
        reason: err instanceof Error ? err.message : "Failed to inject Claude Code channel wake",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.host}:${port}/wake`,
    runtimeSession,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

export function channelContent(request: WakeRequest): string {
  return [
    "Slock wake hint received.",
    `message_id=${request.messageId}`,
    `attempt_id=${request.attemptId}`,
    "Run `slock message check` to pull the pending message.",
  ].join("\n");
}

export function channelMeta(request: WakeRequest): Record<string, string> {
  return {
    slock_message_id: request.messageId,
    slock_attempt_id: request.attemptId,
    slock_event_id: request.eventId,
    slock_agent_id: request.agentId,
    slock_profile: request.profile,
    slock_core_session_id: request.coreSessionId,
    slock_adapter_instance: request.adapterInstance,
  };
}

function validateWakeRequest(value: unknown): WakeRequest {
  if (!value || typeof value !== "object") throw new Error("wake request must be an object");
  const candidate = value as Record<string, unknown>;
  const required = [
    "schema",
    "attemptId",
    "eventId",
    "messageId",
    "agentId",
    "profile",
    "coreSessionId",
    "adapterInstance",
    "occurredAt",
  ] as const;
  for (const key of required) {
    if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
      throw new Error(`wake request ${key} must be a non-empty string`);
    }
    assertSafeMetadataScalar(candidate[key], key);
  }
  if (candidate.schema !== "slock-claude-code-channel-wake.v1") {
    throw new Error("unsupported wake request schema");
  }
  return candidate as unknown as WakeRequest;
}

function assertSafeMetadataScalar(value: unknown, key: string): void {
  if (typeof value !== "string") return;
  if (value.length > 200) {
    throw new Error(`wake request ${key} is too long`);
  }
  if (!/^[a-zA-Z0-9._:@/-]+$/.test(value)) {
    throw new Error(`wake request ${key} contains unsupported characters`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: http.ServerResponse, status: number, value: WakeResponse): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}
