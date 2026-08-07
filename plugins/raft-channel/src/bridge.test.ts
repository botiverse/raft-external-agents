import assert from "node:assert/strict";
import test from "node:test";

import { BridgeSupervisor, bridgeSpawnPlan, buildBridgeArgs, buildBridgeStatusArgs, readBridgeConfig } from "./bridge.js";

test("bridge args do not expose the wake token", () => {
  const config = {
    mode: "spawn" as const,
    command: "slock",
    profile: "agent-profile",
    expectedAgentId: "agent-1",
    profileConflict: false,
    endpoint: "http://127.0.0.1:49152/wake",
    token: "session-secret",
    explicitToken: false,
  };

  assert.deepEqual(buildBridgeArgs(config), [
    "agent",
    "bridge",
    "--json",
    "--wake-adapter",
    "wake-channel",
    "--wake-channel-endpoint",
    "http://127.0.0.1:49152/wake",
    "--expected-agent",
    "agent-1",
  ]);
  assert.deepEqual(buildBridgeStatusArgs(config), [
    "agent",
    "bridge",
    "--json",
    "--wake-adapter",
    "wake-channel",
    "--wake-channel-endpoint",
    "http://127.0.0.1:49152/wake",
    "--expected-agent",
    "agent-1",
  ]);
});

test("spawn mode requires explicit profile provenance", () => {
  const config = readBridgeConfig({ RAFT_EXPECTED_AGENT_ID: "agent-1" }, "http://127.0.0.1:49152/wake", "session-secret", false);
  const supervisor = new BridgeSupervisor(config);

  assert.equal(supervisor.start().state, "missing_profile");
  assert.match(supervisor.getStatus().reason ?? "", /RAFT_PROFILE/);
  assert.match(supervisor.getStatus().reason ?? "", /SLOCK_PROFILE/);
});

test("spawn mode requires an independent expected Agent id", () => {
  const config = readBridgeConfig({ RAFT_PROFILE: "agent-profile" }, "http://127.0.0.1:49152/wake", "session-secret", false);
  const supervisor = new BridgeSupervisor(config);

  assert.equal(supervisor.start().state, "missing_expected_agent");
  assert.match(supervisor.getStatus().reason ?? "", /RAFT_EXPECTED_AGENT_ID/);
});

// CLI rename (slock #2870/#2872): RAFT_PROFILE is canonical, SLOCK_PROFILE a
// deprecation alias; mirror the CLI's both-set-and-different → error rule.
test("RAFT_PROFILE is read and wins resolution", () => {
  const config = readBridgeConfig({ RAFT_PROFILE: "raft-prof", RAFT_EXPECTED_AGENT_ID: "agent-1" }, "http://127.0.0.1:49152/wake", "t", false);
  assert.equal(config.profile, "raft-prof");
  assert.equal(config.profileConflict, false);
});

test("legacy SLOCK_PROFILE alias still resolves", () => {
  const config = readBridgeConfig({ SLOCK_PROFILE: "legacy-prof" }, "http://127.0.0.1:49152/wake", "t", false);
  assert.equal(config.profile, "legacy-prof");
});

test("equal RAFT_PROFILE and SLOCK_PROFILE are not a conflict", () => {
  const config = readBridgeConfig(
    { RAFT_PROFILE: "same", SLOCK_PROFILE: "same" },
    "http://127.0.0.1:49152/wake",
    "t",
    false,
  );
  assert.equal(config.profile, "same");
  assert.equal(config.profileConflict, false);
});

test("conflicting profile envs fail closed instead of silently picking one", () => {
  const config = readBridgeConfig(
    { RAFT_PROFILE: "one", SLOCK_PROFILE: "other" },
    "http://127.0.0.1:49152/wake",
    "t",
    false,
  );
  assert.equal(config.profile, undefined);
  assert.equal(config.profileConflict, true);
  const supervisor = new BridgeSupervisor(config);
  assert.equal(supervisor.start().state, "missing_profile");
  assert.match(supervisor.getStatus().reason ?? "", /different values/);
});

test("attach mode requires operator-provided token", () => {
  const config = readBridgeConfig({
    RAFT_CHANNEL_BRIDGE_MODE: "attach",
    SLOCK_PROFILE: "agent-profile",
  }, "http://127.0.0.1:49152/wake", "generated-secret", false);
  const supervisor = new BridgeSupervisor(config);

  assert.equal(supervisor.start().state, "missing_token");
  assert.match(supervisor.getStatus().reason ?? "", /RAFT_CHANNEL_TOKEN/);
});

test("attach mode can report manual bridge path when token was explicit", () => {
  const config = readBridgeConfig({
    RAFT_CHANNEL_BRIDGE_MODE: "attach",
    SLOCK_PROFILE: "agent-profile",
  }, "http://127.0.0.1:49152/wake", "operator-secret", true);
  const supervisor = new BridgeSupervisor(config);

  assert.equal(supervisor.start().state, "attach_only");
  assert.match(supervisor.getStatus().reason ?? "", /start `slock agent bridge --json` separately/);
});

// task #87 finding 3: spawn-once supervision left the CC session wake-dead
// for its entire remainder after any bridge crash (live-confirmed on the qa
// rig: kill the child -> pending messages never wake again). The supervisor
// must respawn an unexpectedly-exited child with backoff; deliberate stop()
// must not respawn.
test("supervisor respawns an unexpectedly exited bridge child with backoff", async () => {
  const config = readBridgeConfig(
    { SLOCK_PROFILE: "profile-restart", RAFT_EXPECTED_AGENT_ID: "agent-1", RAFT_CHANNEL_BRIDGE_COMMAND: process.execPath },
    "http://127.0.0.1:0/wake",
    "token-restart",
    true,
  );
  // `node <bridge args...>` exits immediately with a usage error — perfect
  // stand-in for a crashing child.
  const supervisor = new BridgeSupervisor(config, { baseDelayMs: 50, maxDelayMs: 200, stableAfterMs: 10_000 });
  supervisor.start();

  const sawRestartingWithBackoff = await new Promise<boolean>((resolve) => {
    const deadline = Date.now() + 5_000;
    const poll = setInterval(() => {
      const status = supervisor.getStatus();
      if ((status.restartCount ?? 0) >= 2) {
        clearInterval(poll);
        resolve(true);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, 25);
  });
  assert.equal(sawRestartingWithBackoff, true, "child must be respawned repeatedly, not abandoned after first exit");
  const status = supervisor.getStatus();
  assert.ok((status.restartCount ?? 0) >= 2);
  assert.ok((status.nextRestartDelayMs ?? 0) >= 50, "consecutive fast exits must back off");

  await supervisor.stop();
  const restartsAtStop = supervisor.getStatus().restartCount ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(supervisor.getStatus().restartCount ?? 0, restartsAtStop, "stop() must cancel respawn");
  assert.equal(supervisor.getStatus().state, "stopped");
});

// Windows field bug (#wg-external-agent 2026-06-11): npm exposes the CLI as
// `slock.cmd`, which Node's spawn() cannot resolve without a shell — the
// bridge child died with `spawn slock ENOENT` on every Windows install.
// Shell + args-array would trigger DEP0190, so win32 gets ONE fully-quoted
// command string (paths with spaces survive); other platforms unchanged.
test("bridge child spawn plan: quoted shell string on win32, direct argv elsewhere", () => {
  const direct = bridgeSpawnPlan("linux", "slock", ["agent", "bridge", "--json"]);
  assert.deepEqual(direct, { command: "slock", args: ["agent", "bridge", "--json"], options: { shell: false } });

  const win = bridgeSpawnPlan("win32", "C:\\Program Files\\slock\\slock.cmd", ["agent", "bridge", "--wake-channel-endpoint", "http://127.0.0.1:8646/wake"]);
  assert.equal(win.options.shell, true);
  assert.deepEqual(win.args, [], "win32 must pass a single string, not an args array (DEP0190)");
  assert.equal(
    win.command,
    '"C:\\Program Files\\slock\\slock.cmd" "agent" "bridge" "--wake-channel-endpoint" "http://127.0.0.1:8646/wake"',
  );
});
