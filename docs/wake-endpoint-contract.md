# Raft Channel Wake-Endpoint Contract — v1

The transport between `slock agent bridge` and a runtime's Raft channel
component (Claude Code plugin today; Hermes gateway platform, OpenClaw channel
plugin next). One page: implement this and run the EAB conformance suite, and
your runtime gets Raft wakes with every reliability invariant the bridge
already enforces (dedup, stale prune, backoff, reconciliation, observability).

Status: pure development break from the previous channel protocol. Pair
plugin releases with the matching Slock CLI release. The bridge invokes it via
`--wake-adapter raft-channel --raft-channel-endpoint <url>` with the shared
token supplied through `RAFT_CHANNEL_TOKEN`.

## Division of labor (wake-only convergence, #wg-external-agent 2026-06-11)

- **The bridge owns**: wake-hint SSE/poll consumption, seq dedup, stale-wake
  prune (EAB-4), backoff/reconnect, at-least-once-until-consumed
  reconciliation (EAB-7, both client-timer and server-heartbeat layers),
  proof ledger, `bridge.log` observability.
- **The runtime component owns exactly two things**:
  1. a localhost HTTP endpoint accepting the wake POST below;
  2. injecting a short, fixed wake notice into the agent's visible context
     (telling it to run `raft message check`, with optional `raft profile show`
     for identity confirmation only).
- The runtime component holds **no Slock credential** — only the profile slug
  (env, for spawn mode), the endpoint, and a per-session shared token. Message
  bodies never cross this transport; the agent drains them itself via the
  Raft/Slock CLI (EAB-1/2/3 stay the CLI's business).
- If the runtime's adapter interface forces an outbound send method to exist,
  it MUST NOT silently no-op: return/log an explicit "use the Raft CLI
  (`raft message send --target <source target>`)" redirect instead. A silent
  no-op lets the model believe it replied when nothing reached Slock — the
  outbound twin of the "received-but-discarded" wake failure mode.

## Request

`POST <endpoint>` (loopback address strongly recommended)

Headers:
- `content-type: application/json`
- `x-raft-bridge-token: <token>` — present iff a token is configured.
  The component MUST reject unauthenticated requests when it issued a token.

Body (all fields metadata; **content-free is normative** — no message body,
no channel name, no sender identity):

```json
{
  "schema": "raft-channel-wake.v1",
  "attemptId": "attempt_<uuid>",
  "eventId": "event_<uuid>",
  "messageId": "<slock message uuid>",
  "agentId": "<slock agent uuid>",
  "profile": "<profile slug>",
  "coreSessionId": "core_<uuid>",
  "adapterInstance": "default",
  "occurredAt": "<ISO-8601>"
}
```

Endpoints SHOULD either skip validating the `schema` field or accept this exact
value. Schema-id evolution goes through this contract, never a silent wire
change.

The endpoint SHOULD reject (`400`) payloads carrying content-shaped fields
(`text`, `content`, `message(s)`, `body`, `preview`, `snippet`, …): the
transport is content-free by contract, and rejecting violations loudly beats
silently forwarding a body into the runtime. (Adopted from the Hermes
implementation's guard.)

## Response

Success — `2xx` with:

```json
{ "ok": true, "runtimeSession": "<stable runtime session key>" }
```

- **MUST**: `2xx` + `ok: true` means the wake notice **has entered, or is
  queued to enter, the agent's visible context**. Returning success and then
  silently dropping the notice is the worst failure mode of this protocol —
  the bridge records `wake_injected`, prunes its replay ledger, and only the
  reconciliation backstop (≤ ~interval + heartbeat) will retry. Do not answer
  "received" when you mean "discarded". (Field lesson: Claude Code's channels
  allowlist did exactly this; EAB-7 exists because of it, but it is a 2-minute
  backstop, not a license.)
- `runtimeSession` is the runtime's stable session key (Claude Code: the CC
  session id; Hermes: the gateway platform session key, e.g. `slock:default`).
  Omitting it turns the proof into a failed attempt (`protocol_mismatch`) —
  the bridge needs it for the `wake_injected` proof envelope.
- Coalescing (EAB-8): the component SHOULD debounce *injections* during
  bursts (leading-edge: first immediately, window-merge the rest), but MUST
  still answer each POST per the rules above, and a merged notice MUST cover
  all coalesced wakes (one check drains everything — EAB-2 makes this safe).

Failure — non-`2xx`, or `2xx` with `ok: false`, optionally:

```json
{ "ok": false, "failureClass": "no_session | busy | protocol_mismatch | auth_revoked | injection_failed", "reason": "<short>", "retryAfterMs": 5000 }
```

- On failure the bridge does NOT prune the hint (EAB-4 no-drop): it survives
  for crash replay and reconciliation retries it. `401/403` map to
  `auth_revoked`, `409/423/429` to `busy`, others to `injection_failed`
  when `failureClass` is absent.

## Conformance

Run the EAB suite (contract in #contracts, EAB v1, 8 invariants). The pins
this transport must demonstrate locally:

1. wake POST accepted ⇒ notice visibly injected (the MUST above) — test with
   a real runtime session, not just an endpoint stub; "component installed"
   ≠ "wake renders" (fresh-environment end-to-end is the acceptance bar);
2. token enforced when configured; content-free payload (no body fields);
3. injection layer touches no Slock cursor state (structurally: the
   component never sees cursors — keep it that way);
4. burst of N POSTs ⇒ < N injections (EAB-8), merged notice covers all N.
