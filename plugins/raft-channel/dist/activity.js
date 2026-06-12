import { randomUUID } from "node:crypto";
// Activity reporting with managed parity (task #110, #wg-external-agent:97eb4c3f).
//
// xxchan ruling 2026-06-12: activity reporting exists to SEE what the agent is
// doing — tool content is included, matching the managed daemon's trajectory
// (`tool_start {toolName, toolInput}` carries full input there). External
// reports flow over the user's own credential to the user's own server, so the
// trust domain equals managed; the discipline is uniform TRUNCATION, not
// blanking. What is still excluded in v0:
// - model thinking / assistant text: NOT a parity boundary (managed does
//   report thinking — agentProcessManager.ts:4861); excluded for mechanism
//   cost only (hook payloads carry no model output; transcript_path parsing
//   is the v0.5 cut).
// - transcript_path itself is never read or transmitted.
// Provenance: the server marks these events external/plugin-reported
// (self-reported BYO telemetry) regardless of content.
export const ACTIVITY_EVENT_SCHEMA = "raft-activity.v1";
export const ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1";
/** v0 event set (open enum — server must tolerate unknown names). */
export const V0_HOOK_EVENTS = new Set([
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "Stop",
    "SessionStart",
    "SessionEnd",
]);
/** Uniform content cap per field; truncation is marked, never silent. */
export const CONTENT_CAP = 4096;
const SAFE_SCALAR = /^[a-zA-Z0-9._:@/ -]+$/;
const MAX_SCALAR_LENGTH = 120;
function safeScalar(value) {
    if (typeof value !== "string" || value.length === 0)
        return undefined;
    if (value.length > MAX_SCALAR_LENGTH)
        return undefined;
    if (!SAFE_SCALAR.test(value))
        return undefined;
    return value;
}
function contentString(value) {
    if (value === undefined || value === null)
        return undefined;
    let text;
    if (typeof value === "string") {
        text = value;
    }
    else {
        try {
            text = JSON.stringify(value);
        }
        catch {
            return undefined;
        }
    }
    if (text.length === 0)
        return undefined;
    if (text.length > CONTENT_CAP) {
        return { text: text.slice(0, CONTENT_CAP), truncated: true };
    }
    return { text, truncated: false };
}
/**
 * Build an activity event from a raw Claude Code hook payload.
 * Returns null when the payload is not reportable (unknown event, malformed).
 *
 * Reads: hook_event_name, session_id, tool_name, tool_input, tool_output,
 * error. NEVER reads transcript_path (full session content) or prompt.
 */
export function buildActivityEvent(payload, now = () => new Date()) {
    if (!payload || typeof payload !== "object")
        return null;
    const raw = payload;
    const hookEventName = safeScalar(raw.hook_event_name);
    if (!hookEventName || !V0_HOOK_EVENTS.has(hookEventName))
        return null;
    const sessionId = safeScalar(raw.session_id) ?? "unknown";
    const toolName = safeScalar(raw.tool_name);
    const isError = hookEventName === "PostToolUseFailure";
    const event = {
        schema: ACTIVITY_EVENT_SCHEMA,
        eventId: randomUUID(),
        sessionId,
        hookEventName,
        status: isError ? "error" : "ok",
        occurredAt: now().toISOString(),
    };
    if (toolName)
        event.toolName = toolName;
    let truncated = false;
    const isToolEvent = hookEventName === "PreToolUse" || hookEventName === "PostToolUse" || isError;
    if (isToolEvent) {
        const input = contentString(raw.tool_input);
        if (input) {
            event.toolInput = input.text;
            if (input.truncated)
                event.toolInputTruncated = true;
            truncated ||= input.truncated;
        }
        const output = contentString(isError ? raw.error : raw.tool_output);
        if (output) {
            event.toolOutput = output.text;
            if (output.truncated)
                event.toolOutputTruncated = true;
            truncated ||= output.truncated;
        }
    }
    if (truncated)
        event.truncated = true;
    if (isError)
        event.errorClass = "tool_failure";
    return event;
}
// Session orientation (task #116): SessionStart runs as a SYNC hook (the only
// non-async entry in hooks.json) so Claude Code reads the hook's stdout JSON
// and injects this context. Wording is the canonical text shared with the web
// setup card's --append-system-prompt (slock #2891) — the hook makes it
// zero-config for sessions launched without that flag, and re-injects after
// resume/compaction.
export const RAFT_SESSION_ORIENTATION = "You are connected to Raft, a shared workspace for humans and agents. " +
    "Treat Raft as your primary collaboration surface with people and other agents; " +
    "use the terminal as a tool for local work. " +
    "If you need the operating guide, run raft manual get raft-cli-overview.";
export function buildSessionStartOutput(payload) {
    if (!payload || typeof payload !== "object")
        return null;
    if (payload.hook_event_name !== "SessionStart")
        return null;
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: RAFT_SESSION_ORIENTATION,
        },
    });
}
/**
 * Bounded in-memory queue. Activity is loss-tolerant telemetry: when the cap
 * is hit the OLDEST events are dropped and the drop is surfaced via the
 * `dropped` counter on the next drain (no silent truncation).
 */
export class ActivityQueue {
    cap;
    events = [];
    droppedSinceDrain = 0;
    constructor(cap = 500) {
        this.cap = Math.max(1, cap);
    }
    push(event) {
        this.events.push(event);
        while (this.events.length > this.cap) {
            this.events.shift();
            this.droppedSinceDrain += 1;
        }
    }
    /** Returns up to `max` oldest events and removes them (at-most-once). */
    drain(max = 200) {
        const take = Math.max(1, Math.min(max, this.events.length || 1));
        const events = this.events.splice(0, take);
        const dropped = this.droppedSinceDrain;
        this.droppedSinceDrain = 0;
        return { schema: ACTIVITY_DRAIN_SCHEMA, events, dropped };
    }
    get size() {
        return this.events.length;
    }
}
/**
 * Validate an incoming POST /activity body (from the hook script). The hook
 * builds events with buildActivityEvent, but the endpoint re-validates:
 * unknown keys are REJECTED (not stripped) and content fields are re-capped,
 * so a buggy sender cannot smuggle unbounded or unexpected fields into the
 * queue.
 */
export function validateActivityEvent(value) {
    if (!value || typeof value !== "object")
        throw new Error("activity event must be an object");
    const raw = value;
    if (raw.schema !== ACTIVITY_EVENT_SCHEMA)
        throw new Error("unsupported activity event schema");
    const allowed = new Set([
        "schema", "eventId", "sessionId", "hookEventName", "status", "occurredAt",
        "toolName", "toolInput", "toolOutput",
        "toolInputTruncated", "toolOutputTruncated", "truncated", "errorClass",
    ]);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key))
            throw new Error(`activity event field ${key} is not allowed`);
    }
    for (const key of ["eventId", "sessionId", "hookEventName", "occurredAt"]) {
        if (!safeScalar(raw[key]))
            throw new Error(`activity event ${key} must be a safe non-empty string`);
    }
    if (raw.status !== "ok" && raw.status !== "error")
        throw new Error("activity event status must be ok|error");
    if (raw.toolName !== undefined && !safeScalar(raw.toolName))
        throw new Error("activity event toolName must be a safe string");
    if (raw.errorClass !== undefined && !safeScalar(raw.errorClass))
        throw new Error("activity event errorClass must be a safe string");
    for (const key of ["truncated", "toolInputTruncated", "toolOutputTruncated"]) {
        if (raw[key] !== undefined && typeof raw[key] !== "boolean")
            throw new Error(`activity event ${key} must be a boolean`);
    }
    const event = raw;
    for (const key of ["toolInput", "toolOutput"]) {
        const content = raw[key];
        if (content === undefined)
            continue;
        if (typeof content !== "string")
            throw new Error(`activity event ${key} must be a string`);
        if (content.length > CONTENT_CAP) {
            event[key] = content.slice(0, CONTENT_CAP);
            event.truncated = true;
        }
    }
    return event;
}
