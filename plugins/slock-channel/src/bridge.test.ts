import assert from "node:assert/strict";
import test from "node:test";

import { BridgeSupervisor, buildBridgeArgs, buildBridgeStatusArgs, readBridgeConfig } from "./bridge.js";

test("bridge args do not expose the wake token", () => {
  const config = {
    mode: "spawn" as const,
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
