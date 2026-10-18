/**
 * Builds a distributable agent package:
 *
 *   release/openrmm-agent-v<version>/
 *     openrmm-agent.js    single-file bundle (agent + shared, no node_modules)
 *     openrmm-agent.cmd   Windows launcher
 *     openrmm-agent       macOS/Linux launcher
 *     LICENSE
 *     README.txt
 *
 * plus openrmm-agent-v<version>.zip (Windows) or the bare folder.
 *
 * Targets only need Node.js >= 24 installed.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
);
const version = pkg.version;

const releaseRoot = path.join(pkgDir, "release");
const outDir = path.join(releaseRoot, `openrmm-agent-v${version}`);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. Bundle the agent and @openrmm/shared into a single ESM file.
await build({
  entryPoints: [path.join(pkgDir, "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: path.join(outDir, "openrmm-agent.js"),
  define: { "globalThis.__OPENRMM_AGENT_VERSION__": JSON.stringify(version) },
  logLevel: "info",
});

// 2. Launchers
fs.writeFileSync(
  path.join(outDir, "openrmm-agent.cmd"),
  '@echo off\r\nnode "%~dp0openrmm-agent.js" %*\r\n',
);
fs.writeFileSync(
  path.join(outDir, "openrmm-agent"),
  '#!/bin/sh\nexec node "$(dirname "$0")/openrmm-agent.js" "$@"\n',
  { mode: 0o755 },
);

// 3. License + quick-start
fs.copyFileSync(
  path.join(pkgDir, "..", "..", "LICENSE"),
  path.join(outDir, "LICENSE"),
);
fs.writeFileSync(path.join(outDir, "README.txt"), readmeText(version));

// 4. Zip on Windows; leave the folder elsewhere.
if (process.platform === "win32") {
  const zip = path.join(releaseRoot, `openrmm-agent-v${version}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${outDir}' -DestinationPath '${zip}'`,
    ],
    { stdio: "inherit" },
  );
  console.log(`\nPackaged: ${zip}`);
} else {
  console.log(`\nPackaged: ${outDir}`);
}

function readmeText(v) {
  return [
    `OpenRMM agent v${v}`,
    "===================",
    "",
    "Requirements: Node.js >= 24 installed on the endpoint.",
    "",
    "Windows:",
    "  openrmm-agent.cmd install --server https://your-server --key <install-key>",
    "  openrmm-agent.cmd run",
    "",
    "macOS / Linux:",
    "  ./openrmm-agent install --server https://your-server --key <install-key>",
    "  ./openrmm-agent run",
    "",
    "Commands:",
    "  install     save server URL + install key (config: ~/.openrmm-agent)",
    "  run         connect to the server and keep reporting",
    "  uninstall   remove the local config",
    "  version     print the agent version",
    "",
    "Keep the agent running permanently: on Windows wrap `run` with NSSM or",
    "Task Scheduler; on macOS create a LaunchAgent plist.",
    "",
    "Licensed under AGPL-3.0-or-later; see LICENSE.",
    "",
  ].join("\n");
}
