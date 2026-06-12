import http from "node:http";
import { randomUUID } from "node:crypto";
export async function startWakeServer(options) {
    const runtimeSession = options.runtimeSession ?? `claude_${randomUUID()}`;
    const server = http.createServer(async (req, res) => {
        if (req.method !== "POST" || req.url !== "/wake") {
            writeJson(res, 404, {
                ok: false,
                failureClass: "no_session",
                reason: "Unknown Raft Claude channel endpoint",
            });
            return;
        }
        if (options.token && req.headers["x-raft-bridge-token"] !== options.token) {
            writeJson(res, 401, {
                ok: false,
                failureClass: "auth_revoked",
                reason: "Invalid Raft bridge token",
            });
            return;
        }
        let body;
        try {
            body = validateWakeRequest(JSON.parse(await readBody(req)));
        }
        catch (err) {
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
        }
        catch (err) {
            writeJson(res, 500, {
                ok: false,
                failureClass: "injection_failed",
                reason: err instanceof Error ? err.message : "Failed to inject Claude Code channel wake",
            });
        }
    });
    await new Promise((resolve, reject) => {
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
export class DebouncedWakeNotifier {
    debounceMs;
    maxBatchSize;
    notifier;
    pending = [];
    timer;
    windowSend;
    windowActive = false;
    constructor(options) {
        this.debounceMs = Math.max(0, options.debounceMs);
        this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 20);
        this.notifier = options.notifier;
    }
    notify(request) {
        if (this.debounceMs === 0) {
            return this.notifier.notify([request]);
        }
        if (!this.windowActive) {
            this.windowActive = true;
            this.windowSend = this.notifier.notify([request]);
            this.timer = setTimeout(() => {
                this.timer = undefined;
                void this.closeWindow();
            }, this.debounceMs);
            return this.windowSend;
        }
        return new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject });
            if (this.pending.length >= this.maxBatchSize) {
                void this.closeWindow();
            }
        });
    }
    async closeWindow() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const pending = this.pending.splice(0);
        const windowSend = this.windowSend;
        this.windowSend = undefined;
        this.windowActive = false;
        try {
            await windowSend;
            for (const item of pending)
                item.resolve();
        }
        catch (err) {
            for (const item of pending)
                item.reject(err);
        }
    }
}
export function channelContent(request) {
    return channelBatchContent([request]);
}
export function channelBatchContent(requests) {
    const count = requests.length;
    const first = requests[0];
    const messageIds = requests.slice(0, 5).map((request) => request.messageId);
    const lines = [
        count > 1 ? `Raft wake hints received. pending_count=${count}` : "Raft wake hint received.",
        "If you have not read the Raft manual in this Claude Code session, run `raft manual get slock-cli-overview` before using Raft commands.",
        "Run `raft profile show` if you need to confirm which agent profile is active; profile output is identity context, not the source of channel/thread permissions or reply targets.",
    ];
    if (count > 1) {
        lines.push(`message_ids=${messageIds.join(",")}`);
        if (count > messageIds.length) {
            lines.push(`additional_message_count=${count - messageIds.length}`);
        }
    }
    else {
        lines.push(`message_id=${first.messageId}`);
        lines.push(`attempt_id=${first.attemptId}`);
    }
    lines.push("Run `raft message check` to pull the pending message.");
    return lines.join("\n");
}
export function channelMeta(request) {
    return channelBatchMeta([request]);
}
export function channelBatchMeta(requests) {
    const first = requests[0];
    const messageIds = requests.slice(0, 8).map((request) => request.messageId);
    return [
        {
            raft_message_id: first.messageId,
            raft_attempt_id: first.attemptId,
            raft_event_id: first.eventId,
            raft_agent_id: first.agentId,
            raft_profile: first.profile,
            raft_core_session_id: first.coreSessionId,
            raft_adapter_instance: first.adapterInstance,
        },
        requests.length > 1 ? {
            raft_wake_batch_size: String(requests.length),
            raft_message_ids: messageIds.join(","),
        } : {},
    ].reduce((acc, item) => Object.assign(acc, item), {});
}
function validateWakeRequest(value) {
    if (!value || typeof value !== "object")
        throw new Error("wake request must be an object");
    const candidate = value;
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
    ];
    for (const key of required) {
        if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
            throw new Error(`wake request ${key} must be a non-empty string`);
        }
        assertSafeMetadataScalar(candidate[key], key);
    }
    if (candidate.schema !== "raft-channel-wake.v1") {
        throw new Error("unsupported wake request schema");
    }
    return candidate;
}
function assertSafeMetadataScalar(value, key) {
    if (typeof value !== "string")
        return;
    if (value.length > 200) {
        throw new Error(`wake request ${key} is too long`);
    }
    if (!/^[a-zA-Z0-9._:@/-]+$/.test(value)) {
        throw new Error(`wake request ${key} contains unsupported characters`);
    }
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
function writeJson(res, status, value) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
}
