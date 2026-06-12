export declare const ACTIVITY_EVENT_SCHEMA = "raft-activity.v1";
export declare const ACTIVITY_DRAIN_SCHEMA = "raft-activity-drain.v1";
/** v0 event set (open enum — server must tolerate unknown names). */
export declare const V0_HOOK_EVENTS: Set<string>;
/** Uniform content cap per field; truncation is marked, never silent. */
export declare const CONTENT_CAP = 4096;
export interface ActivityEvent {
    schema: typeof ACTIVITY_EVENT_SCHEMA;
    eventId: string;
    sessionId: string;
    hookEventName: string;
    status: "ok" | "error";
    occurredAt: string;
    toolName?: string;
    /** Stringified tool input (managed `tool_start.toolInput` parity), capped. */
    toolInput?: string;
    /** Stringified tool output/error, capped. */
    toolOutput?: string;
    /** Set when any content field hit CONTENT_CAP. */
    truncated?: boolean;
    errorClass?: string;
}
/**
 * Build an activity event from a raw Claude Code hook payload.
 * Returns null when the payload is not reportable (unknown event, malformed).
 *
 * Reads: hook_event_name, session_id, tool_name, tool_input, tool_output,
 * error. NEVER reads transcript_path (full session content) or prompt.
 */
export declare function buildActivityEvent(payload: unknown, now?: () => Date): ActivityEvent | null;
export interface DrainResult {
    schema: typeof ACTIVITY_DRAIN_SCHEMA;
    events: ActivityEvent[];
    /** Events dropped since the last drain (queue cap overflow). */
    dropped: number;
}
/**
 * Bounded in-memory queue. Activity is loss-tolerant telemetry: when the cap
 * is hit the OLDEST events are dropped and the drop is surfaced via the
 * `dropped` counter on the next drain (no silent truncation).
 */
export declare class ActivityQueue {
    private readonly cap;
    private events;
    private droppedSinceDrain;
    constructor(cap?: number);
    push(event: ActivityEvent): void;
    /** Returns up to `max` oldest events and removes them (at-most-once). */
    drain(max?: number): DrainResult;
    get size(): number;
}
/**
 * Validate an incoming POST /activity body (from the hook script). The hook
 * builds events with buildActivityEvent, but the endpoint re-validates:
 * unknown keys are REJECTED (not stripped) and content fields are re-capped,
 * so a buggy sender cannot smuggle unbounded or unexpected fields into the
 * queue.
 */
export declare function validateActivityEvent(value: unknown): ActivityEvent;
