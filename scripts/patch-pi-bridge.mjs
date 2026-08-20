#!/usr/bin/env node
// patch-pi-bridge.mjs
//
// Wires the pi → bb event bridge by patching bb's bundled pi provider bridge
// (bb-pi-bridge.mjs) to set BB_BRIDGE_SOCKET_PATH / BB_BRIDGE_TOKEN in the pi
// process environment before any pi session is created.
//
// Background: bb 0.39.0's provider-pi embeds the pi coding agent in-process
// inside a host-daemon bridge worker. That worker never sets the bridge env
// vars, so the pi-bb-bridge extension (env-gated on BB_BRIDGE_SOCKET_PATH)
// stays a no-op and no pi events ever reach bb-plugin-pi-events-bridge.
//
// The chokepoint plugin publishes its connection info to
//   <tmpdir>/bb-plugin-pi-events-bridge.json
// (see packages/bb-plugin-pi-events-bridge/server.ts). This patch makes the
// bridge worker read that file and export the values into process.env.
//
// The patch is idempotent and survives bb updates only if re-run after an
// update — run `node scripts/patch-pi-bridge.mjs` again (or wire it into
// your bb update flow). `--revert` removes it.
//
// Usage:
//   node scripts/patch-pi-bridge.mjs [--revert] [--bridge <path>]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "// [bb-plugins] pi-bb-bridge env wiring (scripts/patch-pi-bridge.mjs)";

// The snippet is inserted at module scope (right after the shebang). It reads
// the chokepoint's bridge-info file and exports the values into process.env
// unless already set (so an explicit user env wins).
const SNIPPET = `
${MARKER}
import { readFileSync as __bbp_readFileSync } from "node:fs";
import { tmpdir as __bbp_tmpdir } from "node:os";
import { join as __bbp_join } from "node:path";
try {
  const __bbp_info = JSON.parse(
    __bbp_readFileSync(__bbp_join(__bbp_tmpdir(), "bb-plugin-pi-events-bridge.json"), "utf8"),
  );
  if (!process.env.BB_BRIDGE_SOCKET_PATH && __bbp_info.socketPath) {
    process.env.BB_BRIDGE_SOCKET_PATH = __bbp_info.socketPath;
  }
  if (!process.env.BB_BRIDGE_TOKEN && __bbp_info.token) {
    process.env.BB_BRIDGE_TOKEN = __bbp_info.token;
  }
} catch {
  // chokepoint not running (yet); pi-bb-bridge stays a no-op until it is
}
`;

function findBridgePath(explicit) {
  if (explicit) return resolve(explicit);
  // Resolve the `bb` binary on PATH; the bridge lives next to it in the
  // host-daemon dist directory.
  try {
    const bbBin = execFileSync("which", ["bb"], { encoding: "utf8" }).trim();
    if (bbBin) {
      const real = execFileSync("readlink", ["-f", bbBin], { encoding: "utf8" }).trim() || bbBin;
      const candidate = join(dirname(real), "bb-pi-bridge.mjs");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through to npx cache search
  }
  // Fallback: search the npx cache for any bb-app host-daemon dist.
  const npxRoot = join(process.env.HOME ?? "", ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const candidate = join(
        npxRoot,
        entry,
        "node_modules",
        "bb-app",
        "host-daemon",
        "dist",
        "bb-pi-bridge.mjs",
      );
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(
    "Could not locate bb-pi-bridge.mjs. Pass --bridge <path> to point at it.",
  );
}

const args = process.argv.slice(2);
const revert = args.includes("--revert");
const explicit = args.find((a) => a.startsWith("--bridge="))?.slice("--bridge=".length);

const bridgePath = findBridgePath(explicit);
const original = readFileSync(bridgePath, "utf8");

if (original.includes(MARKER)) {
  if (revert) {
    // Remove the whole injected block: from the marker line through the end
    // of the catch block (the snippet's last line).
    const patched = original.replace(
      new RegExp(
        `\\n${MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?chokepoint not running \\(yet\\); pi-bb-bridge stays a no-op until it is\\n}\\n`,
      ),
      "",
    );
    writeFileSync(bridgePath, patched);
    console.log(`reverted patch in ${bridgePath}`);
  } else {
    console.log(`already patched: ${bridgePath}`);
  }
  process.exit(0);
}

if (revert) {
  console.log(`not patched: ${bridgePath}`);
  process.exit(0);
}

// Insert after the shebang line (or at the very top if there is none).
const nl = original.indexOf("\n");
const head = original.slice(0, nl + 1);
const rest = original.slice(nl + 1);
writeFileSync(bridgePath, `${head}${SNIPPET}${rest}`);
console.log(`patched ${bridgePath}`);
