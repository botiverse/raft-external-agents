import { type ActivityQueue } from "./activity.js";
export interface WakeRequest {
    schema: "raft-channel-wake.v1";
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
export interface ChannelBatchNotifier {
    notify(requests: readonly WakeRequest[]): Promise<void>;
}
export interface DebouncedWakeNotifierOptions {
    debounceMs: number;
    maxBatchSize?: number;
    notifier: ChannelBatchNotifier;
}
export interface WakeServerOptions {
    host: string;
    port: number;
    token?: string;
    runtimeSession?: string;
    notifier: ChannelNotifier;
    /** When present, exposes POST /activity + GET /activity/drain (task #110). */
    activityQueue?: ActivityQueue;
}
export interface StartedWakeServer {
    url: string;
    runtimeSession: string;
    close(): Promise<void>;
}
export declare function startWakeServer(options: WakeServerOptions): Promise<StartedWakeServer>;
export declare class DebouncedWakeNotifier implements ChannelNotifier {
    private readonly debounceMs;
    private readonly maxBatchSize;
    private readonly notifier;
    private pending;
    private timer;
    private windowSend;
    private windowActive;
    constructor(options: DebouncedWakeNotifierOptions);
    notify(request: WakeRequest): Promise<void>;
    closeWindow(): Promise<void>;
}
export declare function channelContent(request: WakeRequest): string;
export declare function channelBatchContent(requests: readonly WakeRequest[]): string;
export declare function channelMeta(request: WakeRequest): Record<string, string>;
export declare function channelBatchMeta(requests: readonly WakeRequest[]): Record<string, string>;
