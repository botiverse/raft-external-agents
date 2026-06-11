import { spawn } from "node:child_process";
import readline from "node:readline";
export function readBridgeConfig(env, endpoint, token, explicitToken) {
    const mode = env.SLOCK_CLAUDE_CHANNEL_BRIDGE_MODE === "attach" ? "attach" : "spawn";
    return {
        mode,
        command: env.SLOCK_CLAUDE_CHANNEL_BRIDGE_COMMAND || "slock",
        profile: env.SLOCK_PROFILE?.trim() || undefined,
        endpoint,
        token,
        explicitToken,
    };
}
export function buildBridgeArgs(config) {
    return [
        "agent",
        "bridge",
        "--json",
        "--wake-adapter",
        "claude-code-channels",
        "--claude-channel-endpoint",
        config.endpoint,
    ];
}
export function buildBridgeStatusArgs(config) {
    return buildBridgeArgs(config);
}
export class BridgeSupervisor {
    config;
    child;
    status;
    restartTimer;
    spawnedAtMs;
    consecutiveFastExits = 0;
    restartCount = 0;
    restartBaseMs;
    restartMaxMs;
    stableAfterMs;
    constructor(config, restart = {}) {
        this.config = config;
        this.status = this.initialStatus(config);
        this.restartBaseMs = restart.baseDelayMs ?? 1_000;
        this.restartMaxMs = restart.maxDelayMs ?? 60_000;
        this.stableAfterMs = restart.stableAfterMs ?? 60_000;
    }
    start() {
        if (this.config.mode === "attach") {
            return this.status;
        }
        if (!this.config.profile) {
            return this.status;
        }
        if (this.child) {
            return this.status;
        }
        const args = buildBridgeArgs(this.config);
        const statusArgs = buildBridgeStatusArgs(this.config);
        this.status = {
            mode: "spawn",
            state: "starting",
            command: this.config.command,
            args: statusArgs,
            profile: this.config.profile,
            endpoint: this.config.endpoint,
            startedAt: new Date().toISOString(),
        };
        const env = {
            ...process.env,
            SLOCK_PROFILE: this.config.profile,
            SLOCK_CLAUDE_CHANNEL_TOKEN: this.config.token,
        };
        const child = spawn(this.config.command, args, {
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        this.child = child;
        child.once("spawn", () => {
            this.spawnedAtMs = Date.now();
            this.status = {
                ...this.status,
                state: "running",
                pid: child.pid,
                ...(this.restartCount > 0 ? { restartCount: this.restartCount } : {}),
            };
            console.error(`Slock bridge child started pid=${child.pid} profile=${this.config.profile}`);
        });
        child.once("error", (err) => {
            this.status = {
                ...this.status,
                state: "spawn_error",
                reason: err.message,
                exitedAt: new Date().toISOString(),
            };
            this.child = undefined;
            console.error(`Slock bridge child failed to start: ${err.message}`);
        });
        child.once("exit", (exitCode, signal) => {
            const deliberatelyStopped = this.status.state === "stopped";
            this.status = {
                ...this.status,
                state: deliberatelyStopped ? "stopped" : "exited",
                exitCode,
                signal,
                exitedAt: new Date().toISOString(),
            };
            this.child = undefined;
            console.error(`Slock bridge child exited code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
            // task #87 finding 3: spawn-once left the CC session wake-dead for its
            // entire remainder after any bridge crash/fatal exit (live-confirmed:
            // kill child -> pending messages never wake again). Respawn with
            // exponential backoff; a child that stays up `stableAfterMs` resets the
            // backoff. Deliberate stop() never respawns.
            if (!deliberatelyStopped) {
                this.scheduleRestart();
            }
        });
        if (child.stdout)
            pipeLines(child.stdout, "slock bridge stdout");
        if (child.stderr)
            pipeLines(child.stderr, "slock bridge stderr");
        return this.status;
    }
    scheduleRestart() {
        if (this.restartTimer)
            return;
        const aliveMs = this.spawnedAtMs ? Date.now() - this.spawnedAtMs : 0;
        if (aliveMs >= this.stableAfterMs) {
            this.consecutiveFastExits = 0;
        }
        else {
            this.consecutiveFastExits += 1;
        }
        const delayMs = Math.min(this.restartBaseMs * 2 ** Math.max(0, this.consecutiveFastExits - 1), this.restartMaxMs);
        this.restartCount += 1;
        this.status = {
            ...this.status,
            state: "restarting",
            restartCount: this.restartCount,
            nextRestartDelayMs: delayMs,
        };
        console.error(`Slock bridge child restart #${this.restartCount} scheduled in ${delayMs}ms`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.status.state === "stopped")
                return;
            this.start();
        }, delayMs);
        this.restartTimer.unref?.();
    }
    async stop() {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = undefined;
        }
        if (!this.child) {
            this.status = {
                ...this.status,
                state: this.status.state === "attach_only" || this.status.state === "missing_profile" || this.status.state === "missing_token" ? this.status.state : "stopped",
            };
            return;
        }
        const child = this.child;
        this.status = {
            ...this.status,
            state: "stopped",
            exitedAt: new Date().toISOString(),
        };
        await new Promise((resolve) => {
            let exited = false;
            child.once("exit", () => {
                exited = true;
                resolve();
            });
            child.kill("SIGTERM");
            setTimeout(() => {
                if (!exited)
                    child.kill("SIGKILL");
                resolve();
            }, 2_000).unref();
        });
    }
    getStatus() {
        return { ...this.status, args: this.status.args ? [...this.status.args] : undefined };
    }
    initialStatus(config) {
        if (config.mode === "attach") {
            if (!config.explicitToken) {
                return {
                    mode: "attach",
                    state: "missing_token",
                    endpoint: config.endpoint,
                    reason: "Attach mode requires SLOCK_CLAUDE_CHANNEL_TOKEN so unauthenticated localhost wake POSTs stay rejected.",
                };
            }
            return {
                mode: "attach",
                state: "attach_only",
                endpoint: config.endpoint,
                reason: "Plugin is in attach mode; start `slock agent bridge --json` separately.",
            };
        }
        if (!config.profile) {
            return {
                mode: "spawn",
                state: "missing_profile",
                command: config.command,
                endpoint: config.endpoint,
                reason: "SLOCK_PROFILE is required so the plugin can spawn bridge-core with an explicit profile.",
            };
        }
        return {
            mode: "spawn",
            state: "starting",
            command: config.command,
            profile: config.profile,
            endpoint: config.endpoint,
        };
    }
}
function pipeLines(stream, label) {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
        console.error(`[${label}] ${line}`);
    });
}
