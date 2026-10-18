/**
 * Native service installation for the agent.
 *
 * Windows : registers a real SCM service via WinSW (MIT), which wraps
 *           `node <agent> run`. Requires Administrator rights.
 * macOS   : installs a user LaunchAgent plist (KeepAlive) via launchctl.
 * Linux   : not supported yet.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentHome } from "./config.js";

export const SERVICE_ID = "openrmm-agent";
export const SERVICE_NAME = "OpenRMM Agent";
const MAC_LABEL = "com.openrmm.agent";

export type ServiceAction = "install" | "uninstall" | "start" | "stop" | "status";

/** Path of the script that runs the agent (the bundle, or dist/index.js). */
export function agentEntryPath(): string {
  const self = fileURLToPath(import.meta.url);
  // In the repo build service.js lives next to index.js in dist/.
  if (path.basename(self) === "service.js") {
    return path.join(path.dirname(self), "index.js");
  }
  return self;
}

export function runServiceAction(action: ServiceAction): void {
  if (process.platform === "win32") return windows(action);
  if (process.platform === "darwin") return macos(action);
  console.error(
    `Native service installation is not supported on ${process.platform} yet. ` +
      "Run the agent with a process supervisor (systemd, cron, etc.) instead.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Windows — WinSW-based SCM service
// ---------------------------------------------------------------------------

function run(exe: string, args: string[], allowFailure = false): void {
  const res = spawnSync(exe, args, { stdio: "inherit", windowsHide: true });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`command failed (exit ${res.status}): ${exe} ${args.join(" ")}`);
  }
}

function isElevatedWindows(): boolean {
  try {
    execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function requireElevated(): void {
  if (!isElevatedWindows()) {
    console.error(
      "Administrator rights are required to manage Windows services.\n" +
        "Re-run this command from an elevated terminal (right-click PowerShell → Run as administrator).",
    );
    process.exit(1);
  }
}

/** Locate WinSW: the packaged release ships it next to the agent bundle;
 *  the repo build uses the vendored copy in vendor/winsw/. */
function winswExe(): string {
  const candidates: string[] = [
    path.join(path.dirname(agentEntryPath()), "winsw.exe"),
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "vendor",
      "winsw",
      "winsw.exe",
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "winsw.exe not found. Build the agent release package (npm run package:agent) " +
      "or ensure packages/agent/vendor/winsw/winsw.exe exists in a source checkout.",
  );
}

function windowsServiceDir(): string {
  return path.join(agentHome(), "service");
}

function windowsServiceFiles(): { dir: string; exe: string; xml: string } {
  const dir = windowsServiceDir();
  return {
    dir,
    exe: path.join(dir, `${SERVICE_ID}-service.exe`),
    xml: path.join(dir, `${SERVICE_ID}-service.xml`),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function winswConfigXml(): string {
  const node = escapeXml(process.execPath);
  const entry = escapeXml(agentEntryPath());
  const home = escapeXml(agentHome());
  return [
    "<service>",
    `  <id>${SERVICE_ID}</id>`,
    `  <name>${SERVICE_NAME}</name>`,
    "  <description>OpenRMM remote monitoring and management agent (AGPL-3.0-or-later)</description>",
    `  <executable>${node}</executable>`,
    `  <arguments>"${entry}" run</arguments>`,
    `  <env name="RMM_AGENT_HOME" value="${home}"/>`,
    `  <env name="RMM_AGENT_SERVICE" value="1"/>`,
    '  <log mode="rotate"/>',
    '  <onfailure action="restart" delay="10 sec"/>',
    '  <onfailure action="restart" delay="60 sec"/>',
    "</service>",
    "",
  ].join("\n");
}

function windows(action: ServiceAction): void {
  const files = windowsServiceFiles();

  switch (action) {
    case "install": {
      requireElevated();
      if (!fs.existsSync(agentHome() + path.sep + "agent.json")) {
        console.error(
          `No agent config found in ${agentHome()}. Run "openrmm-agent install --server <url> --key <key>" first.`,
        );
        process.exit(1);
      }
      fs.mkdirSync(files.dir, { recursive: true });
      fs.copyFileSync(winswExe(), files.exe);
      fs.writeFileSync(files.xml, winswConfigXml());
      run(files.exe, ["install"]);
      run(files.exe, ["start"]);
      console.log(`Service "${SERVICE_NAME}" installed and started.`);
      windowsStatus();
      break;
    }

    case "uninstall": {
      requireElevated();
      if (fs.existsSync(files.exe)) {
        run(files.exe, ["stop"], true);
        run(files.exe, ["uninstall"], true);
        fs.rmSync(files.dir, { recursive: true, force: true });
      }
      console.log(`Service "${SERVICE_NAME}" uninstalled.`);
      break;
    }

    case "start": {
      requireElevated();
      if (!fs.existsSync(files.exe)) {
        console.error("Service is not installed. Run: openrmm-agent service install");
        process.exit(1);
      }
      run(files.exe, ["start"]);
      break;
    }

    case "stop": {
      requireElevated();
      if (!fs.existsSync(files.exe)) {
        console.error("Service is not installed. Run: openrmm-agent service install");
        process.exit(1);
      }
      run(files.exe, ["stop"], true);
      break;
    }

    case "status": {
      windowsStatus();
      break;
    }
  }
}

function windowsStatus(): void {
  const files = windowsServiceFiles();
  if (!fs.existsSync(files.exe)) {
    console.log(`Service "${SERVICE_NAME}" is not installed.`);
    return;
  }
  run(files.exe, ["status"], true);
}

// ---------------------------------------------------------------------------
// macOS — user LaunchAgent
// ---------------------------------------------------------------------------

function launchctl(args: string[], allowFailure = false): void {
  const res = spawnSync("launchctl", args, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFailure) {
    throw new Error(`launchctl ${args.join(" ")} failed (exit ${res.status})`);
  }
}

function macDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) throw new Error("cannot determine user id for launchctl domain");
  return `gui/${uid}`;
}

function macPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function macPlistXml(): string {
  const node = escapeXml(process.execPath);
  const entry = escapeXml(agentEntryPath());
  const home = escapeXml(agentHome());
  const log = escapeXml(path.join(agentHome(), "logs", "agent.log"));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${MAC_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${node}</string>`,
    `    <string>${entry}</string>`,
    "    <string>run</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>RMM_AGENT_HOME</key>",
    `    <string>${home}</string>`,
    "    <key>RMM_AGENT_SERVICE</key>",
    "    <string>1</string>",
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>StandardOutPath</key>",
    `  <string>${log}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function macos(action: ServiceAction): void {
  const plist = macPlistPath();
  const domain = macDomain();

  switch (action) {
    case "install": {
      if (!fs.existsSync(path.join(agentHome(), "agent.json"))) {
        console.error(
          `No agent config found in ${agentHome()}. Run "openrmm-agent install --server <url> --key <key>" first.`,
        );
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.mkdirSync(path.join(agentHome(), "logs"), { recursive: true });
      fs.writeFileSync(plist, macPlistXml());
      launchctl(["bootout", `${domain}/${MAC_LABEL}`], true); // replace if loaded
      launchctl(["bootstrap", domain, plist]);
      console.log(`LaunchAgent "${MAC_LABEL}" installed and started.`);
      macosStatus();
      break;
    }

    case "uninstall": {
      launchctl(["bootout", `${domain}/${MAC_LABEL}`], true);
      if (fs.existsSync(plist)) fs.unlinkSync(plist);
      console.log(`LaunchAgent "${MAC_LABEL}" uninstalled.`);
      break;
    }

    case "start": {
      if (!fs.existsSync(plist)) {
        console.error("Service is not installed. Run: openrmm-agent service install");
        process.exit(1);
      }
      launchctl(["bootstrap", domain, plist], true); // error if already loaded
      launchctl(["kickstart", "-k", `${domain}/${MAC_LABEL}`]);
      console.log(`LaunchAgent "${MAC_LABEL}" started.`);
      break;
    }

    case "stop": {
      launchctl(["bootout", `${domain}/${MAC_LABEL}`], true);
      console.log(`LaunchAgent "${MAC_LABEL}" stopped.`);
      break;
    }

    case "status": {
      macosStatus();
      break;
    }
  }
}

function macosStatus(): void {
  const res = spawnSync(
    "launchctl",
    ["print", `${macDomain()}/${MAC_LABEL}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  if (res.status !== 0) {
    console.log(`LaunchAgent "${MAC_LABEL}" is not running.`);
    return;
  }
  const out = res.stdout.toString();
  const running = /state\s*=\s*running/.test(out);
  console.log(
    `LaunchAgent "${MAC_LABEL}" is ${running ? "running" : "loaded but not running"}.`,
  );
}
