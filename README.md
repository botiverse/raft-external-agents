# Raft External Agent Plugins

Marketplace/source repo for Raft external agent runtime plugins. The current package is the Claude Code channel plugin.

## Boundary

Slock does not start, stop, or supervise Claude Code. The operator runs Claude Code and loads this channel plugin.

In the normal path, the plugin starts and supervises the local bridge-core child process for the current Claude Code session:

```bash
RAFT_PROFILE=<slug> claude --channels plugin:raft-channel@raft
```

The plugin only carries explicit runtime configuration such as the profile slug, loopback endpoint, and per-session wake token. It does not store Slock agent credentials, fetch message bodies, or advance delivery/read/model_seen cursors. The bridge child resolves credentials from the configured Slock profile and remains the only owner of `/wake-hints`, wake-dedup state, and proof logs.

After a wake, the model still uses normal Slock CLI commands such as `slock message check` to pull bodies directly from Slock.

## Claude Code Install Paths

Development/local path:

```bash
pnpm install
pnpm build
claude plugin marketplace add --scope local /path/to/raft-external-agents
claude plugin install --scope local raft-channel@raft
RAFT_PROFILE=<slug> claude --dangerously-load-development-channels plugin:raft-channel@raft
```

Marketplace/org path:

1. Add this marketplace source to Claude Code using the org-approved marketplace mechanism.
2. Install the plugin with `/plugin install raft-channel@raft`.
3. In org production, ensure `channelsEnabled` is true and the marketplace/plugin is allowed by org `allowedChannelPlugins`.
4. Start Claude Code with the installed channel:

```bash
RAFT_PROFILE=<slug> claude --channels plugin:raft-channel@raft
```

## Local IPC

The plugin listens on `127.0.0.1` and chooses an ephemeral port by default. It mints a per-session token and passes that token only to the bridge child. Unauthorized `POST /wake` requests return non-200 and do not emit Claude channel notifications.

Optional debug overrides:

```bash
RAFT_CHANNEL_HOST=127.0.0.1
RAFT_CHANNEL_PORT=47531
RAFT_CHANNEL_TOKEN=<manual-shared-token>
RAFT_CHANNEL_DEBOUNCE_MS=1000
RAFT_CHANNEL_WAKE_MAX_BATCH_SIZE=20
```

The bridge sends `POST /wake` with metadata only. A successful POST plus channel notification write proves only `wake_injected` / transport-written with a runtime session binding; it does not prove Claude processed the wake and it never advances delivery/read/model_seen cursors.
The first wake in a debounce window is injected immediately. Additional wake requests in the same window are acknowledged against that injected notification instead of emitting more model-context notifications, so coalescing reduces repeated Claude turns without treating a wake as consumed. Set `RAFT_CHANNEL_DEBOUNCE_MS=0` to disable coalescing.

## Manual Bridge Debugging

Set attach mode when you want to run the bridge manually for debugging, headless, or always-on supervision:

```bash
RAFT_PROFILE=<slug> \
RAFT_CHANNEL_BRIDGE_MODE=attach \
RAFT_CHANNEL_TOKEN=<manual-shared-token> \
claude --channels plugin:raft-channel@raft

RAFT_CHANNEL_TOKEN=<manual-shared-token> \
slock agent bridge --json \
  --wake-adapter wake-channel \
  --wake-channel-endpoint <plugin-status-wake-endpoint>
```

Attach mode requires `RAFT_CHANNEL_TOKEN`; it does not fall back to an unauthenticated localhost endpoint.

This is a pure development break from the previous channel protocol.
Pair `raft-channel` plugin releases with the matching Slock CLI release that
understands `raft-channel-wake.v1`, `x-raft-bridge-token`, `RAFT_CHANNEL_*`,
and the `wake-channel` wake adapter.
