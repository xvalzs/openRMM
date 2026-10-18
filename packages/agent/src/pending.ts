/**
 * OS pending-update counts, collected best-effort:
 *  - Windows: Windows Update COM search (no admin required)
 *  - macOS:   `softwareupdate -l`
 * Both are slow; callers should cache the result.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { spawn } from "node:child_process";

const CHECK_TIMEOUT_MS = 90_000;

function runCommand(
  command: string,
  args: string[],
  parse: (stdout: string) => number | null,
): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, CHECK_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(parse(out));
    });
  });
}

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$s = New-Object -ComObject Microsoft.Update.Session",
  "$r = $s.CreateUpdateSearcher().Search('IsInstalled=0')",
  "Write-Output $r.Updates.Count",
].join("; ");

export async function collectPendingUpdates(): Promise<number | null> {
  if (process.platform === "win32") {
    return runCommand(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
      (out) => {
        const n = Number(out.trim());
        return Number.isInteger(n) && n >= 0 ? n : null;
      },
    );
  }
  if (process.platform === "darwin") {
    return runCommand("softwareupdate", ["-l"], (out) => {
      const lines = out.split("\n").filter((l) => /^\s*\*/.test(l));
      return lines.length;
    });
  }
  return null;
}
