export type BridgeMode = "spawn" | "attach";
export type BridgeState = "attach_only" | "missing_profile" | "missing_token" | "starting" | "running" | "spawn_error" | "exited" | "restarting" | "stopped";
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
    restartCount?: number;
    nextRestartDelayMs?: number;
}
export declare function readBridgeConfig(env: NodeJS.ProcessEnv, endpoint: string, token: string, explicitToken: boolean): BridgeConfig;
export declare function buildBridgeArgs(config: BridgeConfig): string[];
export declare function buildBridgeStatusArgs(config: BridgeConfig): string[];
export interface BridgeSupervisorRestartOptions {
    /** First respawn delay after a child exit. */
    baseDelayMs?: number;
    /** Backoff ceiling for consecutive fast exits. */
    maxDelayMs?: number;
    /** A child that stayed alive at least this long resets the backoff. */
    stableAfterMs?: number;
}
export declare class BridgeSupervisor {
    private readonly config;
    private child?;
    private status;
    private restartTimer?;
    private spawnedAtMs?;
    private consecutiveFastExits;
    private restartCount;
    private readonly restartBaseMs;
    private readonly restartMaxMs;
    private readonly stableAfterMs;
    constructor(config: BridgeConfig, restart?: BridgeSupervisorRestartOptions);
    start(): BridgeStatus;
    private scheduleRestart;
    stop(): Promise<void>;
    getStatus(): BridgeStatus;
    private initialStatus;
}
