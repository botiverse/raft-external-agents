import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

export type BridgeMode = "spawn" | "attach";

export type BridgeState =
  | "attach_only"
  | "missing_profile"
  | "missing_token"
  | "starting"
  | "running"
  | "spawn_error"
  | "exited"
  | "stopped";

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

export function readBridgeConfig(env: NodeJS.ProcessEnv, endpoint: string, token: string, explicitToken: boolean): BridgeConfig {
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

export function buildBridgeArgs(config: BridgeConfig): string[] {
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

export function buildBridgeStatusArgs(config: BridgeConfig): string[] {
  return buildBridgeArgs(config);
}

export class BridgeSupervisor {
  private child?: ChildProcess;
  private status: BridgeStatus;

  constructor(private readonly config: BridgeConfig) {
    this.status = this.initialStatus(config);
  }

  start(): BridgeStatus {
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

    if (child.stdout) pipeLines(child.stdout, "slock bridge stdout");
    if (child.stderr) pipeLines(child.stderr, "slock bridge stderr");

    return this.status;
  }

  async stop(): Promise<void> {
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
    await new Promise<void>((resolve) => {
      let exited = false;
      child.once("exit", () => {
        exited = true;
        resolve();
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
  }

  getStatus(): BridgeStatus {
    return { ...this.status, args: this.status.args ? [...this.status.args] : undefined };
  }

  private initialStatus(config: BridgeConfig): BridgeStatus {
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

function pipeLines(stream: NodeJS.ReadableStream, label: string): void {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    console.error(`[${label}] ${line}`);
  });
}
