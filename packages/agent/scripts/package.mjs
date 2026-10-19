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
 * plus openrmm-agent-v<version>.zip.
 *
 * Targets only need Node.js >= 24 installed.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import archiver from "archiver";

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

// 4. Windows service wrapper (WinSW, MIT) used by `service install`.
fs.copyFileSync(
  path.join(pkgDir, "vendor", "winsw", "winsw.exe"),
  path.join(outDir, "winsw.exe"),
);
fs.writeFileSync(
  path.join(outDir, "THIRD_PARTY_NOTICES.txt"),
  thirdPartyNotices(),
);

// 5. node-pty (MIT) for real terminal shells. The bundled agent loads it
//    via createRequire from its own directory; the native binaries live in
//    optional @lydell/node-pty-<platform> packages.
const nodePtySrc = path.join(pkgDir, "..", "..", "node_modules", "@lydell", "node-pty");
if (fs.existsSync(nodePtySrc)) {
  fs.cpSync(nodePtySrc, path.join(outDir, "node_modules", "@lydell", "node-pty"), {
    recursive: true,
  });
  const scopeDir = path.dirname(nodePtySrc);
  for (const entryName of fs.readdirSync(scopeDir)) {
    if (entryName.startsWith("node-pty-")) {
      const dir = path.join(scopeDir, entryName);
      if (fs.statSync(dir).isDirectory()) {
        fs.cpSync(dir, path.join(outDir, "node_modules", "@lydell", entryName), {
          recursive: true,
        });
      }
    }
  }
}

// 4. Zip the release (cross-platform).
const zip = path.join(releaseRoot, `openrmm-agent-v${version}.zip`);
fs.rmSync(zip, { force: true });
const output = fs.createWriteStream(zip);
const archive = archiver("zip", { zlib: { level: 6 } });
const done = finished(output);
archive.on("error", (e) => {
  if (e) output.destroy(e);
});
archive.pipe(output);
archive.directory(outDir, false);
await archive.finalize();
await done;
console.log(`\nPackaged: ${zip}`);

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
    "  service     install/uninstall/start/stop/status the native service",
    "  uninstall   remove the local config",
    "  version     print the agent version",
    "",
    "Run as a native service:",
    "  Windows (run from an elevated PowerShell):",
    "    openrmm-agent.cmd service install",
    "  macOS:",
    "    ./openrmm-agent service install",
    "",
    "Licensed under AGPL-3.0-or-later; see LICENSE.",
    "",
  ].join("\n");
}

function thirdPartyNotices() {
  return [
    "OpenRMM agent package — third-party notices",
    "===========================================",
    "",
    "WinSW (winsw.exe)",
    "-----------------",
    "Copyright (c) Kohsuke Kawaguchi, Oleg Nenashev and contributors.",
    "Licensed under the MIT License.",
    "https://github.com/winsw/winsw",
    "Version 2.12.0 (NET461 build).",
    "Used as the Windows service wrapper for `openrmm-agent service install`.",
    "Requires .NET Framework 4.6.1 or later (built into Windows 10/11).",
    "",
    "node-pty (@lydell/node-pty)",
    "---------------------------",
    "Copyright (c) 2013-2015 Christopher Jeffrey (MIT)",
    "Copyright (c) contributors",
    "Licensed under the MIT License.",
    "https://github.com/lydell/node-pty",
    "Provides real terminal (PTY) support for remote shells.",
    "",
    "MIT License",
    "-----------",
    "",
    "Permission is hereby granted, free of charge, to any person obtaining",
    "a copy of this software and associated documentation files (the",
    "'Software'), to deal in the Software without restriction, including",
    "without limitation the rights to use, copy, modify, merge, publish,",
    "distribute, sublicense, and/or sell copies of the Software, and to",
    "permit persons to whom the Software is furnished to do so, subject to",
    "the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be",
    "included in all copies or substantial portions of the Software.",
    "",
    "THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,",
    "EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF",
    "MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.",
    "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY",
    "CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,",
    "TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE",
    "SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
    "",
  ].join("\n");
}
