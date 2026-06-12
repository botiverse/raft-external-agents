import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityQueue,
  CONTENT_CAP,
  buildActivityEvent,
  validateActivityEvent,
} from "./activity.js";

const BASE_PAYLOAD = {
  session_id: "sess-1",
  transcript_path: "/home/user/.claude/projects/x/transcript.jsonl",
  cwd: "/home/user/project",
  permission_mode: "default",
};

test("tool events carry name, input, and output (managed parity)", () => {
  const event = buildActivityEvent({
    ...BASE_PAYLOAD,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    tool_output: "On branch main",
  });
  assert.ok(event);
  assert.equal(event.hookEventName, "PostToolUse");
  assert.equal(event.toolName, "Bash");
  assert.equal(event.toolInput, JSON.stringify({ command: "git status" }));
  assert.equal(event.toolOutput, "On branch main");
  assert.equal(event.status, "ok");
  assert.equal(event.truncated, undefined);
});

test("tool failure maps to error status with error output", () => {
  const event = buildActivityEvent({
    ...BASE_PAYLOAD,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "exit 1" },
    error: "Command failed with exit code 1",
  });
  assert.ok(event);
  assert.equal(event.status, "error");
  assert.equal(event.errorClass, "tool_failure");
  assert.equal(event.toolOutput, "Command failed with exit code 1");
});

test("oversized content is truncated WITH a marker, never silently", () => {
  const event = buildActivityEvent({
    ...BASE_PAYLOAD,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { content: "x".repeat(CONTENT_CAP * 2) },
  });
  assert.ok(event);
  assert.ok(event.toolInput);
  assert.equal(event.toolInput.length, CONTENT_CAP);
  assert.equal(event.truncated, true);
});

test("transcript_path and prompt are never copied into the event", () => {
  const event = buildActivityEvent({
    ...BASE_PAYLOAD,
    hook_event_name: "UserPromptSubmit",
    prompt: "secret user prompt text",
  });
  assert.ok(event);
  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /transcript/);
  assert.doesNotMatch(serialized, /secret user prompt/);
  assert.doesNotMatch(serialized, /\.jsonl/);
});

test("lifecycle events carry no content fields", () => {
  for (const name of ["UserPromptSubmit", "Stop", "SessionStart", "SessionEnd"]) {
    const event = buildActivityEvent({
      ...BASE_PAYLOAD,
      hook_event_name: name,
      tool_input: { smuggled: "should not appear" },
      tool_output: "should not appear either",
    });
    assert.ok(event, name);
    assert.equal(event.toolInput, undefined, name);
    assert.equal(event.toolOutput, undefined, name);
  }
});

test("unknown events and malformed payloads are not reportable", () => {
  assert.equal(buildActivityEvent({ ...BASE_PAYLOAD, hook_event_name: "PreCompact" }), null);
  assert.equal(buildActivityEvent("not an object"), null);
  assert.equal(buildActivityEvent(null), null);
  assert.equal(buildActivityEvent({}), null);
});

test("queue caps, drops oldest, and surfaces the drop count on drain", () => {
  const queue = new ActivityQueue(3);
  for (let i = 0; i < 5; i++) {
    const event = buildActivityEvent({ ...BASE_PAYLOAD, hook_event_name: "Stop" });
    assert.ok(event);
    queue.push({ ...event, eventId: `event-${i}` });
  }
  assert.equal(queue.size, 3);
  const drained = queue.drain(10);
  assert.equal(drained.schema, "raft-activity-drain.v1");
  assert.equal(drained.events.length, 3);
  assert.equal(drained.events[0].eventId, "event-2");
  assert.equal(drained.dropped, 2);
  assert.equal(queue.size, 0);
  assert.equal(queue.drain(10).dropped, 0);
});

test("drain respects max and keeps the remainder", () => {
  const queue = new ActivityQueue(10);
  for (let i = 0; i < 4; i++) {
    const event = buildActivityEvent({ ...BASE_PAYLOAD, hook_event_name: "Stop" });
    assert.ok(event);
    queue.push({ ...event, eventId: `event-${i}` });
  }
  const first = queue.drain(2);
  assert.deepEqual(first.events.map((e) => e.eventId), ["event-0", "event-1"]);
  assert.equal(queue.size, 2);
});

test("validation rejects unknown fields instead of stripping them", () => {
  const event = buildActivityEvent({ ...BASE_PAYLOAD, hook_event_name: "Stop" });
  assert.ok(event);
  assert.throws(
    () => validateActivityEvent({ ...event, transcript_path: "/leak/path" }),
    /not allowed/,
  );
  assert.throws(
    () => validateActivityEvent({ ...event, prompt: "leak" }),
    /not allowed/,
  );
});

test("validation re-caps oversized content from a buggy sender", () => {
  const event = buildActivityEvent({
    ...BASE_PAYLOAD,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: "ok",
  });
  assert.ok(event);
  const validated = validateActivityEvent({ ...event, toolOutput: "y".repeat(CONTENT_CAP + 50) });
  assert.equal(validated.toolOutput?.length, CONTENT_CAP);
  assert.equal(validated.truncated, true);
});

test("validation enforces schema and status closed set", () => {
  const event = buildActivityEvent({ ...BASE_PAYLOAD, hook_event_name: "Stop" });
  assert.ok(event);
  assert.throws(() => validateActivityEvent({ ...event, schema: "other.v1" }), /schema/);
  assert.throws(() => validateActivityEvent({ ...event, status: "weird" }), /status/);
});
