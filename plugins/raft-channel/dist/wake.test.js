import assert from "node:assert/strict";
import test from "node:test";
import { DebouncedWakeNotifier, channelBatchContent, channelBatchMeta, channelContent, channelMeta, startWakeServer, } from "./wake.js";
const request = {
    schema: "raft-channel-wake.v1",
    attemptId: "attempt-1",
    eventId: "event-1",
    messageId: "message-1",
    agentId: "agent-1",
    profile: "profile-1",
    coreSessionId: "core-1",
    adapterInstance: "adapter-1",
    occurredAt: "2026-06-09T15:00:00.000Z",
};
const secondRequest = {
    ...request,
    attemptId: "attempt-2",
    eventId: "event-2",
    messageId: "message-2",
};
test("channel payload is content-free and maps citation metadata to underscore keys", () => {
    assert.match(channelContent(request), /raft message check/);
    assert.match(channelContent(request), /raft manual get slock-cli-overview/);
    assert.match(channelContent(request), /raft profile show/);
    assert.match(channelContent(request), /identity context/);
    assert.match(channelContent(request), /not read the Raft manual in this Claude Code session/);
    assert.doesNotMatch(channelContent(request), /body|content=/);
    assert.deepEqual(channelMeta(request), {
        raft_message_id: "message-1",
        raft_attempt_id: "attempt-1",
        raft_event_id: "event-1",
        raft_agent_id: "agent-1",
        raft_profile: "profile-1",
        raft_core_session_id: "core-1",
        raft_adapter_instance: "adapter-1",
    });
});
test("batched channel payload coalesces wake hints without message bodies", () => {
    const content = channelBatchContent([request, secondRequest]);
    assert.match(content, /Raft wake hints received\. pending_count=2/);
    assert.match(content, /message_ids=message-1,message-2/);
    assert.match(content, /raft message check/);
    assert.match(content, /raft profile show/);
    assert.doesNotMatch(content, /body|content=/);
    assert.deepEqual(channelBatchMeta([request, secondRequest]), {
        raft_message_id: "message-1",
        raft_attempt_id: "attempt-1",
        raft_event_id: "event-1",
        raft_agent_id: "agent-1",
        raft_profile: "profile-1",
        raft_core_session_id: "core-1",
        raft_adapter_instance: "adapter-1",
        raft_wake_batch_size: "2",
        raft_message_ids: "message-1,message-2",
    });
});
test("debounced wake notifier sends the leading wake immediately and coalesces burst tails", async () => {
    const batches = [];
    const notifier = new DebouncedWakeNotifier({
        debounceMs: 20,
        notifier: {
            async notify(wakes) {
                batches.push([...wakes]);
            },
        },
    });
    await notifier.notify(request);
    const coalesced = notifier.notify(secondRequest);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map((wake) => wake.messageId), ["message-1"]);
    await coalesced;
    assert.equal(batches.length, 1);
});
test("wake server accepts metadata wake and rejects invalid token", async () => {
    const notified = [];
    const server = await startWakeServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        notifier: {
            async notify(wake) {
                notified.push(wake);
            },
        },
    });
    try {
        const rejected = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "wrong" },
            body: JSON.stringify(request),
        });
        assert.equal(rejected.status, 401);
        const accepted = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "secret" },
            body: JSON.stringify(request),
        });
        assert.equal(accepted.status, 200);
        const body = await accepted.json();
        assert.equal(body.ok, true);
        assert.equal(body.runtimeSession, server.runtimeSession);
        assert.deepEqual(notified, [request]);
    }
    finally {
        await server.close();
    }
});
test("wake server requires token when configured and does not notify on unauthorized POST", async () => {
    let notified = false;
    const server = await startWakeServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        notifier: {
            async notify() {
                notified = true;
            },
        },
    });
    try {
        const rejected = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
        });
        assert.equal(rejected.status, 401);
        assert.equal(notified, false);
    }
    finally {
        await server.close();
    }
});
test("wake server rejects unsafe metadata before notification", async () => {
    let notified = false;
    const server = await startWakeServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        notifier: {
            async notify() {
                notified = true;
            },
        },
    });
    try {
        const rejected = await fetch(server.url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "secret" },
            body: JSON.stringify({ ...request, messageId: "message-1\ninject" }),
        });
        assert.equal(rejected.status, 400);
        assert.equal(notified, false);
    }
    finally {
        await server.close();
    }
});
test("activity endpoint accepts valid events, rejects bad tokens and smuggled fields, and drains", async () => {
    const { ActivityQueue, buildActivityEvent } = await import("./activity.js");
    const queue = new ActivityQueue(10);
    const server = await startWakeServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        activityQueue: queue,
        notifier: { async notify() { } },
    });
    const activityUrl = server.url.replace(/\/wake$/, "/activity");
    try {
        const event = buildActivityEvent({
            session_id: "sess-1",
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_input: { command: "ls" },
            tool_output: "ok",
        });
        assert.ok(event);
        const unauthorized = await fetch(activityUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "wrong" },
            body: JSON.stringify(event),
        });
        assert.equal(unauthorized.status, 401);
        assert.equal(queue.size, 0);
        const smuggled = await fetch(activityUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "secret" },
            body: JSON.stringify({ ...event, transcript_path: "/leak" }),
        });
        assert.equal(smuggled.status, 400);
        assert.equal(queue.size, 0);
        const accepted = await fetch(activityUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "secret" },
            body: JSON.stringify(event),
        });
        assert.equal(accepted.status, 202);
        assert.equal(queue.size, 1);
        const drainUnauthorized = await fetch(`${activityUrl}/drain`, {
            headers: { "x-raft-bridge-token": "wrong" },
        });
        assert.equal(drainUnauthorized.status, 401);
        const drained = await fetch(`${activityUrl}/drain?max=10`, {
            headers: { "x-raft-bridge-token": "secret" },
        });
        assert.equal(drained.status, 200);
        const body = await drained.json();
        assert.equal(body.schema, "raft-activity-drain.v1");
        assert.equal(body.events.length, 1);
        assert.equal(body.dropped, 0);
        assert.equal(queue.size, 0);
    }
    finally {
        await server.close();
    }
});
test("activity routes 404 when no queue is configured", async () => {
    const server = await startWakeServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        notifier: { async notify() { } },
    });
    try {
        const res = await fetch(server.url.replace(/\/wake$/, "/activity"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-raft-bridge-token": "secret" },
            body: "{}",
        });
        assert.equal(res.status, 404);
    }
    finally {
        await server.close();
    }
});
