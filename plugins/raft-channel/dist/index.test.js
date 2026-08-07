import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
test("plugin shuts down bridge child when MCP stdin ends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "raft-channel-eof-"));
    const bridgeCommand = join(dir, "fake-bridge.mjs");
    const startedFile = join(dir, "bridge-started");
    const terminatedFile = join(dir, "bridge-terminated");
    const pluginEntry = fileURLToPath(new URL("./index.js", import.meta.url));
    let plugin;
    try {
        await writeFile(bridgeCommand, [
            "#!/usr/bin/env node",
            "import { writeFileSync } from 'node:fs';",
            "writeFileSync(process.env.BRIDGE_STARTED_FILE, 'started');",
            "process.on('SIGTERM', () => {",
            "  writeFileSync(process.env.BRIDGE_TERMINATED_FILE, 'terminated');",
            "  process.exit(0);",
            "});",
            "setInterval(() => {}, 1_000);",
            "",
        ].join("\n"));
        await chmod(bridgeCommand, 0o700);
        plugin = spawn(process.execPath, [pluginEntry], {
            env: {
                ...process.env,
                SLOCK_PROFILE: "agent-profile",
                RAFT_EXPECTED_AGENT_ID: "agent-1",
                RAFT_CHANNEL_BRIDGE_COMMAND: bridgeCommand,
                RAFT_CHANNEL_PORT: "0",
                BRIDGE_STARTED_FILE: startedFile,
                BRIDGE_TERMINATED_FILE: terminatedFile,
            },
            stdio: ["pipe", "ignore", "pipe"],
        });
        const stderrChunks = [];
        plugin.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
        await waitForFile(startedFile, 5_000, "bridge child to start");
        plugin.stdin?.end();
        const exit = await waitForExit(plugin, 5_000);
        assert.equal(exit.code, 0, Buffer.concat(stderrChunks).toString("utf8"));
        assert.equal(await readFile(terminatedFile, "utf8"), "terminated");
    }
    finally {
        if (plugin && plugin.exitCode === null)
            plugin.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
    }
});
async function waitForFile(path, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await readFile(path);
            return;
        }
        catch {
            await delay(50);
        }
    }
    throw new Error(`Timed out waiting for ${label}`);
}
function waitForExit(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error("Timed out waiting for plugin process to exit"));
        }, timeoutMs);
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
        });
    });
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
test("SessionStart hook output injects the Raft orientation context", async () => {
    const { buildSessionStartOutput, RAFT_SESSION_ORIENTATION } = await import("./activity.js");
    const out = buildSessionStartOutput({ hook_event_name: "SessionStart", session_id: "s", source: "startup" });
    assert.ok(out);
    const parsed = JSON.parse(out);
    assert.equal(parsed.hookSpecificOutput?.hookEventName, "SessionStart");
    assert.equal(parsed.hookSpecificOutput?.additionalContext, RAFT_SESSION_ORIENTATION);
    assert.match(RAFT_SESSION_ORIENTATION, /primary collaboration surface/);
    assert.match(RAFT_SESSION_ORIENTATION, /raft manual get raft-cli-overview/);
    assert.equal(buildSessionStartOutput({ hook_event_name: "Stop" }), null);
    assert.equal(buildSessionStartOutput(null), null);
});
