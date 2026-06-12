export type BridgeMode = "spawn" | "attach";
export type BridgeState = "attach_only" | "missing_profile" | "missing_token" | "starting" | "running" | "spawn_error" | "exited" | "restarting" | "stopped";
export interface BridgeConfig {
    mode: BridgeMode;
    command: string;
    profile?: string;
    /** RAFT_PROFILE and SLOCK_PROFILE both set with different values. */
    profileConflict: boolean;
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
/**
 * Windows field bug (Ruikun, #wg-external-agent 2026-06-11): npm installs the
 * CLI as `slock.cmd`/`slock.ps1`, and Node's spawn() without `shell` does not
 * resolve `.cmd` wrappers from PATH — `spawn slock ENOENT` even though the
 * command works in a terminal. Spawning through the shell fixes that, but
 * shell + args-array triggers DEP0190 (args concatenated unescaped), so on
 * win32 we build ONE fully-quoted command string instead: every token is
 * double-quoted with embedded quotes escaped, which also survives
 * RAFT_CHANNEL_BRIDGE_COMMAND paths containing spaces
 * (`C:\Program Files\...`). All tokens are internally constructed.
 */
export declare function bridgeSpawnPlan(platform: NodeJS.Platform, command: string, args: string[]): {
    command: string;
    args: string[];
    options: {
        shell: boolean;
    };
};
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
