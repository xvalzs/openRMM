/**
 * Installer builder: produces pre-configured agent installers from the
 * admin panel, ScreenConnect-style.
 *
 * Windows: a single self-contained .exe (Node SEA) with the server URL,
 * install key, and deployment id baked into the binary — the filename is
 * arbitrary and renaming never affects the payload (or an Authenticode
 * signature, which hashes content, not names).
 * macOS/Linux: a zip with the bundled agent + node-pty.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import type { InstallerInfo, InstallerTarget } from "@openrmm/shared";
import type { Store } from "./db.js";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const require2 = createRequire(import.meta.url);

type ArchiverFn = (format: string, options?: { zlib?: { level?: number } }) => {
  pipe(out: NodeJS.WritableStream): void;
  file(src: string, opts?: { name?: string; mode?: number }): unknown;
  directory(dir: string, dest: string): unknown;
  finalize(): Promise<void>;
  on(event: string, cb: (err?: Error) => void): unknown;
};
const archiver = require2("archiver") as unknown as ArchiverFn;

export interface InstallerBuildInput {
  name: string;
  target: InstallerTarget;
  serverUrl: string;
  installKey: string;
  autoService: boolean;
  createdBy: string;
}

const AGENT_SOURCE_CANDIDATES = [
  // Repo layout: server/dist → ../../agent/src/index.ts
  () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "src", "index.ts"),
  // Packaged release next to the server, if any
  () => {
    const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "release");
    if (!fs.existsSync(base)) return null;
    const dirs = fs
      .readdirSync(base)
      .filter((d) => d.startsWith("openrmm-agent-v"));
    for (const dir of dirs) {
      const file = path.join(base, dir, "openrmm-agent.js");
      if (fs.existsSync(file)) return file;
    }
    return null;
  },
];

function resolveAgentEntry(): string {
  const env = process.env.RMM_AGENT_SRC;
  if (env && fs.existsSync(env)) return env;
  for (const candidate of AGENT_SOURCE_CANDIDATES) {
    const p = candidate();
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error(
    "agent source not found; set RMM_AGENT_SRC to the agent entry point " +
      "(packages/agent/src/index.ts) or build the release package first",
  );
}

function resolveNodePtyDir(): string | null {
  try {
    // @lydell/node-pty blocks package.json in its exports map; resolve the
    // main entry and walk up to the package root instead.
    const main = require2.resolve("@lydell/node-pty");
    let dir = path.dirname(main);
    for (let i = 0; i < 4; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
          if (pkg.name === "@lydell/node-pty") return dir;
        } catch {
          /* keep walking */
        }
      }
      dir = path.dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the Authenticode signature from a Windows PE executable by
 * zeroing the Security (certificate table) data directory entry. The
 * node.exe used as the SEA base ships signed; injecting the SEA blob
 * corrupts that signature, and signing tools refuse to replace a
 * corrupted signature. Node's own SEA docs recommend removing the old
 * signature before re-signing (signtool remove /s) — this does the same
 * without signtool.
 */
function stripAuthenticodeSignature(filePath: string): void {
  const buf = fs.readFileSync(filePath);
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") return;
  const optHeader = peOffset + 24;
  const magic = buf.readUInt16LE(optHeader);
  let dirStart: number;
  if (magic === 0x20b) {
    dirStart = optHeader + 112; // PE32+
  } else if (magic === 0x10b) {
    dirStart = optHeader + 96; // PE32
  } else {
    return;
  }
  const numDirs = buf.readUInt32LE(magic === 0x20b ? optHeader + 108 : optHeader + 92);
  if (numDirs <= 4) return;
  const secEntry = dirStart + 4 * 8;
  if (buf.readUInt32LE(secEntry) === 0 && buf.readUInt32LE(secEntry + 4) === 0) return;
  buf.writeUInt32LE(0, secEntry); // VirtualAddress
  buf.writeUInt32LE(0, secEntry + 4); // Size
  fs.writeFileSync(filePath, buf);
}

/**
 * Authenticode-sign a Windows executable with the configured PFX.
 * Prefers signtool (Windows SDK); falls back to PowerShell's
 * Set-AuthenticodeSignature so signing works on servers without the SDK.
 * Throws if signing is configured but fails — never silently ships an
 * unsigned installer when a certificate was provided.
 */
function signExecutable(filePath: string, pfx: string, password: string): void {
  const trySigntool = (): boolean => {
    try {
      execFileSync(
        "signtool",
        [
          "sign",
          "/fd", "SHA256",
          "/f", pfx,
          "/p", password,
          "/tr", "http://timestamp.digicert.com",
          "/td", "SHA256",
          filePath,
        ],
        { stdio: "pipe" },
      );
      return true;
    } catch (err) {
      const e = err as { code?: unknown };
      // ENOENT = signtool not installed → fall back to PowerShell.
      if (e.code !== "ENOENT") throw err;
      return false;
    }
  };

  const tryPowerShell = (): void => {
    // Run the signing via -EncodedCommand so the PFX password never
    // appears on a command line, and quoting is not an issue. Uses the
    // .NET X509Certificate2 constructor (Get-PfxCertificate -Password is
    // PS 7 only) so it works on Windows PowerShell 5.1 as well.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$pw = '${password.replace(/'/g, "''")}'`,
      `$pfx = '${pfx.replace(/'/g, "''")}'`,
      `$file = '${filePath.replace(/'/g, "''")}'`,
      "$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2",
      "$cert.Import($pfx, $pw, 'Exportable')",
      "Set-AuthenticodeSignature -FilePath $file -Certificate $cert " +
        "-TimestampServer 'http://timestamp.digicert.com' -HashAlgorithm SHA256 | Out-Null",
      // Fail fast if the result is not actually signed with a matching hash.
      "$sig = Get-AuthenticodeSignature -FilePath $file",
      "if ($sig.Status -eq 'NotSigned' -or $sig.Status -eq 'HashMismatch') { throw \"signature status: $($sig.Status)\" }",
    ].join("\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { stdio: "pipe" },
    );
  };

  if (!trySigntool()) tryPowerShell();
}

/** Node binary for the target architecture (SEA base executable). */
async function resolveNodeBinary(
  target: InstallerTarget,
  dataDir: string,
): Promise<string> {
  if (target === "windows-x64" || target === "posix") return process.execPath;

  // Windows ARM64: env override, cached download, or fail with guidance.
  const envPath = process.env.RMM_NODE_ARM64;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const runtimeDir = path.join(dataDir, "installers", "_runtime");
  const nodeDir = path.join(runtimeDir, `node-${process.version}-win-arm64`);
  const nodeExe = path.join(nodeDir, "node.exe");
  if (fs.existsSync(nodeExe)) return nodeExe;

  fs.mkdirSync(runtimeDir, { recursive: true });
  const zip = path.join(runtimeDir, `node-${process.version}-win-arm64.zip`);
  const url = `https://nodejs.org/dist/${process.version}/node-${process.version}-win-arm64.zip`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `ARM64 Node download failed (HTTP ${res.status}) for ${url} — ` +
        `set RMM_NODE_ARM64 to a local arm64 node.exe to build offline`,
    );
  }
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -Path '${zip}' -DestinationPath '${runtimeDir}' -Force`],
    { stdio: "pipe" },
  );
  if (!fs.existsSync(nodeExe)) {
    throw new Error("ARM64 Node extraction failed; set RMM_NODE_ARM64 to a local arm64 node.exe");
  }
  return nodeExe;
}

export class InstallerBuilder {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
    private readonly agentVersion: string,
  ) {}

  async build(input: InstallerBuildInput): Promise<InstallerInfo> {
    const id = randomUUID();
    const deploymentId = randomUUID();
    const outDir = path.join(this.dataDir, "installers", id);
    const tmp = path.join(outDir, "build");
    fs.mkdirSync(tmp, { recursive: true });

    const defaults = {
      serverUrl: input.serverUrl.replace(/\/+$/, ""),
      installKey: input.installKey,
      deploymentId,
      autoService: input.autoService,
    };
    const define = {
      "globalThis.__OPENRMM_AGENT_VERSION__": JSON.stringify(this.agentVersion),
      "globalThis.__OPENRMM_DEFAULTS__": JSON.stringify(JSON.stringify(defaults)),
    };

    const safeBase = input.name.replace(/[^a-zA-Z0-9 _.-]/g, "").trim().replace(/\s+/g, "-") || "OpenRMM-Agent";
    const isWindows = input.target.startsWith("windows-");
    const isZip = input.target === "posix" || input.target === "windows-zip";
    const filename = isZip ? `${safeBase}.zip` : `${safeBase}.exe`;
    const entry = resolveAgentEntry();
    let filePath: string;

    if (!isZip) {
      const nodeBinary = await resolveNodeBinary(input.target, this.dataDir);
      const cjsPath = path.join(tmp, "agent.cjs");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        outfile: cjsPath,
        define,
        logLevel: "silent",
      });
      // Strip a leading shebang if esbuild preserved one.
      let code = fs.readFileSync(cjsPath, "utf8");
      if (code.startsWith("#!")) code = code.slice(code.indexOf("\n") + 1);
      fs.writeFileSync(cjsPath, code);

      const cfgPath = path.join(tmp, "sea-config.json");
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          main: "agent.cjs",
          output: "agent.blob",
          disableExperimentalSEAWarning: true,
        }),
      );
      execFileSync(process.execPath, ["--experimental-sea-config", cfgPath], {
        cwd: tmp,
        stdio: "pipe",
      });

      filePath = path.join(outDir, filename);
      fs.copyFileSync(nodeBinary, filePath);
      const { inject } = require2("postject") as {
        inject: (
          filename: string,
          resourceName: string,
          data: Buffer,
          opts: { sentinelFuse: string },
        ) => Promise<void>;
      };
      await inject(filePath, "NODE_SEA_BLOB", fs.readFileSync(path.join(tmp, "agent.blob")), {
        sentinelFuse: SEA_FUSE,
      });
      // Optionally sign the executable. Without a signature, Windows
      // SmartScreen / Smart App Control may block or warn about the file.
      // Signing also makes renames safe by construction (Authenticode
      // hashes content, not the file name).
      const pfx = process.env.RMM_SIGNING_PFX;
      if (pfx) {
        if (!fs.existsSync(pfx)) {
          throw new Error(`RMM_SIGNING_PFX set but file not found: ${pfx}`);
        }
        stripAuthenticodeSignature(filePath);
        signExecutable(filePath, pfx, process.env.RMM_SIGNING_PFX_PASSWORD ?? "");
      }
    } else {
      const jsPath = path.join(tmp, "openrmm-agent.js");
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        outfile: jsPath,
        define,
        logLevel: "silent",
      });
      const launcher = path.join(tmp, "openrmm-agent");
      fs.writeFileSync(
        launcher,
        '#!/bin/sh\nexec node "$(dirname "$0")/openrmm-agent.js" "$@"\n',
        { mode: 0o755 },
      );
      const readme = path.join(tmp, "README.txt");
      fs.writeFileSync(
        readme,
        input.target === "windows-zip"
          ? [
              "OpenRMM agent (pre-configured installer)",
              "=========================================",
              "",
              "Requirements: Node.js >= 24 installed on this PC.",
              "",
              "Run:  double-click OpenRMM-Agent.cmd",
              "The agent is already configured for your server and will connect",
              "automatically on first run.",
              "",
              "Licensed under AGPL-3.0-or-later.",
              "",
            ].join("\r\n")
          : [
              "OpenRMM agent (pre-configured installer)",
              "=========================================",
              "",
              "Run:  ./openrmm-agent run",
              "The agent is already configured for your server and will connect",
              "automatically on first run.",
              "",
              "Licensed under AGPL-3.0-or-later.",
              "",
            ].join("\n"),
      );

      filePath = path.join(outDir, filename);
      const output = fs.createWriteStream(filePath);
      const archive = archiver("zip", { zlib: { level: 6 } });
      const done = finished(output);
      archive.on("error", (err) => {
        if (err) output.destroy(err);
      });
      archive.pipe(output);
      archive.file(jsPath, { name: "openrmm-agent.js" });
      if (input.target === "windows-zip") {
        const cmdLauncher = path.join(tmp, "OpenRMM-Agent.cmd");
        fs.writeFileSync(
          cmdLauncher,
          '@echo off\r\nnode "%~dp0openrmm-agent.js" run\r\n',
        );
        archive.file(cmdLauncher, { name: "OpenRMM-Agent.cmd" });
      } else {
        archive.file(launcher, { name: "openrmm-agent", mode: 0o755 });
      }
      archive.file(readme, { name: "README.txt" });
      const license = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "LICENSE",
      );
      if (fs.existsSync(license)) archive.file(license, { name: "LICENSE" });
      const nodePty = resolveNodePtyDir();
      if (nodePty) {
        archive.directory(nodePty, "node_modules/@lydell/node-pty");
        // Native binaries ship in optional @lydell/node-pty-<platform>
        // packages. Windows zips carry only Windows binaries; posix zips
        // carry the macOS/Linux ones.
        const scopeDir = path.dirname(nodePty);
        if (fs.existsSync(scopeDir)) {
          for (const entryName of fs.readdirSync(scopeDir)) {
            if (!entryName.startsWith("node-pty-")) continue;
            if (input.target === "windows-zip" && !entryName.includes("win32")) continue;
            if (input.target === "posix" && entryName.includes("win32")) continue;
            const dir = path.join(scopeDir, entryName);
            if (fs.statSync(dir).isDirectory()) {
              archive.directory(dir, `node_modules/@lydell/${entryName}`);
            }
          }
        }
      }
      await archive.finalize();
      await done;
    }

    fs.rmSync(tmp, { recursive: true, force: true });
    const buf = fs.readFileSync(filePath);
    const record: InstallerInfo = {
      id,
      name: input.name,
      filename,
      target: input.target,
      deploymentId,
      sha256: createHash("sha256").update(buf).digest("hex"),
      size: buf.length,
      createdAt: Date.now(),
      createdBy: input.createdBy,
    };
    this.store.createInstaller(record);
    return record;
  }

  filePath(installer: InstallerInfo): string {
    return path.join(this.dataDir, "installers", installer.id, installer.filename);
  }

  remove(id: string): boolean {
    const installer = this.store.getInstaller(id);
    if (!installer) return false;
    fs.rmSync(path.join(this.dataDir, "installers", id), {
      recursive: true,
      force: true,
    });
    return this.store.deleteInstaller(id);
  }
}
