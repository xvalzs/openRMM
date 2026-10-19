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
import type { InstallerInfo } from "@openrmm/shared";
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
  target: "windows" | "posix";
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
    const filename = input.target === "windows" ? `${safeBase}.exe` : `${safeBase}.zip`;
    const entry = resolveAgentEntry();
    let filePath: string;

    if (input.target === "windows") {
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
      fs.copyFileSync(process.execPath, filePath);
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
      if (pfx && fs.existsSync(pfx)) {
        const pw = process.env.RMM_SIGNING_PFX_PASSWORD ?? "";
        execFileSync(
          "signtool",
          [
            "sign",
            "/fd",
            "SHA256",
            "/f",
            pfx,
            "/p",
            pw,
            "/tr",
            "http://timestamp.digicert.com",
            "/td",
            "SHA256",
            filePath,
          ],
          { stdio: "pipe" },
        );
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
        [
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
      archive.file(launcher, { name: "openrmm-agent", mode: 0o755 });
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
        // packages; include whatever platform packages are installed.
        const scopeDir = path.dirname(nodePty);
        if (fs.existsSync(scopeDir)) {
          for (const entryName of fs.readdirSync(scopeDir)) {
            if (entryName.startsWith("node-pty-")) {
              const dir = path.join(scopeDir, entryName);
              if (fs.statSync(dir).isDirectory()) {
                archive.directory(dir, `node_modules/@lydell/${entryName}`);
              }
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
