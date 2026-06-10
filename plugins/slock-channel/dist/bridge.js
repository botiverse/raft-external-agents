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
    constructor(config) {
        this.config = config;
        this.status = this.initialStatus(config);
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
            this.status = {
                ...this.status,
                state: "running",
                pid: child.pid,
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
            this.status = {
                ...this.status,
                state: this.status.state === "stopped" ? "stopped" : "exited",
                exitCode,
                signal,
                exitedAt: new Date().toISOString(),
            };
            this.child = undefined;
            console.error(`Slock bridge child exited code=${exitCode ?? "null"} signal=${signal ?? "null"}`);
        });
        if (child.stdout)
            pipeLines(child.stdout, "slock bridge stdout");
        if (child.stderr)
            pipeLines(child.stderr, "slock bridge stderr");
        return this.status;
    }
    async stop() {
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
