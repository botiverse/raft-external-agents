# Slock Claude Plugins

Private Botiverse marketplace/source repo for Slock Claude Code plugins.

## Boundary

Slock does not start, stop, or supervise Claude Code. The operator runs Claude Code and loads this channel plugin. The Slock bridge is a separate explicit process:

```bash
slock --profile <slug> agent bridge --json \
  --wake-adapter claude-code-channels \
  --claude-channel-endpoint http://127.0.0.1:47531/wake
```

The plugin exposes a localhost wake endpoint and injects content-free channel notifications into the already-running Claude Code session. It does not store Slock agent credentials, does not fetch message bodies, and does not advance delivery/read/model_seen cursors. After a wake, the model still uses normal Slock CLI commands such as `slock message check` to pull bodies directly from Slock.

## Claude Code Install Paths

Development/local path:

```bash
pnpm install
pnpm build
claude plugin marketplace add --scope local /path/to/slock-claude-plugins
claude plugin install --scope local slock-channel@slock
claude --dangerously-load-development-channels plugin:slock-channel@slock
```

Marketplace/org path:

1. Add this marketplace source to Claude Code using the org-approved marketplace mechanism.
2. Install the plugin with `/plugin install slock-channel@slock`.
3. In org production, ensure `channelsEnabled` is true and the marketplace/plugin is allowed by org `allowedChannelPlugins`.
4. Start Claude Code with the installed channel:

```bash
claude --channels plugin:slock-channel@slock
```

## Local IPC

The plugin listens on `127.0.0.1` and defaults to port `47531`. Override with:

```bash
SLOCK_CLAUDE_CHANNEL_HOST=127.0.0.1
SLOCK_CLAUDE_CHANNEL_PORT=47531
SLOCK_CLAUDE_CHANNEL_TOKEN=<optional-shared-token>
```

The bridge sends `POST /wake` with metadata only. If `SLOCK_CLAUDE_CHANNEL_TOKEN` is set, the bridge must send the same value via `--claude-channel-token`.
