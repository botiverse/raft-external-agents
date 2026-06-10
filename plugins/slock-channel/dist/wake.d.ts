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
export declare function startWakeServer(options: WakeServerOptions): Promise<StartedWakeServer>;
export declare function channelContent(request: WakeRequest): string;
export declare function channelMeta(request: WakeRequest): Record<string, string>;
