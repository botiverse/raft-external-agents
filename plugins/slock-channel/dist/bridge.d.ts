export type BridgeMode = "spawn" | "attach";
export type BridgeState = "attach_only" | "missing_profile" | "missing_token" | "starting" | "running" | "spawn_error" | "exited" | "stopped";
export interface BridgeConfig {
    mode: BridgeMode;
    command: string;
    profile?: string;
    endpoint: string;
    token: string;
    explicitToken: boolean;
}
export interface BridgeStatus {
    mode: BridgeMode;
    state: BridgeState;
    command?: string;
    args?: string[];
    profile?: string;
    endpoint: string;
    pid?: number;
    startedAt?: string;
    exitedAt?: string;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    reason?: string;
}
export declare function readBridgeConfig(env: NodeJS.ProcessEnv, endpoint: string, token: string, explicitToken: boolean): BridgeConfig;
export declare function buildBridgeArgs(config: BridgeConfig): string[];
export declare function buildBridgeStatusArgs(config: BridgeConfig): string[];
export declare class BridgeSupervisor {
    private readonly config;
    private child?;
    private status;
    constructor(config: BridgeConfig);
    start(): BridgeStatus;
    stop(): Promise<void>;
    getStatus(): BridgeStatus;
    private initialStatus;
}
