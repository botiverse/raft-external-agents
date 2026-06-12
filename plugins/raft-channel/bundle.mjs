// Bundle the plugin entry into a single self-contained file. The Claude Code
// marketplace install path clones this repo into the plugin cache WITHOUT
// running pnpm install/build, so the committed dist/index.js must run with
// zero node_modules (task #64: `MCP error -32000: Connection closed` on a
// marketplace install — the manifest's `node dist/index.js` had nothing to
// run). tsc still emits the per-file dist/*.js for tests/typecheck; this
// overwrites the entry with the bundled form afterwards.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(root, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  allowOverwrite: true,
});
console.log("bundled plugins/raft-channel/dist/index.js (self-contained)");

// The activity hook runs as a standalone `node dist/activity-hook.js` from
// hooks.json — same zero-node_modules marketplace constraint as the entry.
await build({
  entryPoints: [path.join(root, "src/activity-hook.ts")],
  outfile: path.join(root, "dist/activity-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  allowOverwrite: true,
});
console.log("bundled plugins/raft-channel/dist/activity-hook.js (self-contained)");
