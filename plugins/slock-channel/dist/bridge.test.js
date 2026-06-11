import assert from "node:assert/strict";
import test from "node:test";
import { BridgeSupervisor, bridgeSpawnOptions, buildBridgeArgs, buildBridgeStatusArgs, readBridgeConfig } from "./bridge.js";
test("bridge args do not expose the wake token", () => {
    const config = {
        mode: "spawn",
        command: "slock",
        profile: "agent-profile",
        endpoint: "http://127.0.0.1:49152/wake",
        token: "session-secret",
        explicitToken: false,
    };
    assert.deepEqual(buildBridgeArgs(config), [
        "agent",
        "bridge",
        "--json",
        "--wake-adapter",
        "claude-code-channels",
        "--claude-channel-endpoint",
        "http://127.0.0.1:49152/wake",
    ]);
    assert.deepEqual(buildBridgeStatusArgs(config), [
        "agent",
        "bridge",
        "--json",
        "--wake-adapter",
        "claude-code-channels",
        "--claude-channel-endpoint",
        "http://127.0.0.1:49152/wake",
    ]);
});
test("spawn mode requires explicit SLOCK_PROFILE provenance", () => {
    const config = readBridgeConfig({}, "http://127.0.0.1:49152/wake", "session-secret", false);
    const supervisor = new BridgeSupervisor(config);
    assert.equal(supervisor.start().state, "missing_profile");
    assert.match(supervisor.getStatus().reason ?? "", /SLOCK_PROFILE/);
});
test("attach mode requires operator-provided token", () => {
    const config = readBridgeConfig({
        SLOCK_CLAUDE_CHANNEL_BRIDGE_MODE: "attach",
        SLOCK_PROFILE: "agent-profile",
    }, "http://127.0.0.1:49152/wake", "generated-secret", false);
    const supervisor = new BridgeSupervisor(config);
    assert.equal(supervisor.start().state, "missing_token");
    assert.match(supervisor.getStatus().reason ?? "", /SLOCK_CLAUDE_CHANNEL_TOKEN/);
});
test("attach mode can report manual bridge path when token was explicit", () => {
    const config = readBridgeConfig({
        SLOCK_CLAUDE_CHANNEL_BRIDGE_MODE: "attach",
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
    const config = readBridgeConfig({ SLOCK_PROFILE: "profile-restart", SLOCK_CLAUDE_CHANNEL_BRIDGE_COMMAND: process.execPath }, "http://127.0.0.1:0/wake", "token-restart", true);
    // `node <bridge args...>` exits immediately with a usage error — perfect
    // stand-in for a crashing child.
    const supervisor = new BridgeSupervisor(config, { baseDelayMs: 50, maxDelayMs: 200, stableAfterMs: 10_000 });
    supervisor.start();
    const sawRestartingWithBackoff = await new Promise((resolve) => {
        const deadline = Date.now() + 5_000;
        const poll = setInterval(() => {
            const status = supervisor.getStatus();
            if ((status.restartCount ?? 0) >= 2) {
                clearInterval(poll);
                resolve(true);
            }
            else if (Date.now() > deadline) {
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
test("bridge child spawns through the shell on win32 and directly elsewhere", () => {
    assert.deepEqual(bridgeSpawnOptions("win32"), { shell: true });
    assert.deepEqual(bridgeSpawnOptions("linux"), { shell: false });
    assert.deepEqual(bridgeSpawnOptions("darwin"), { shell: false });
});
