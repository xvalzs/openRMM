/**
 * Agent self-update: downloads a new single-file agent bundle, verifies
 * its SHA-256, atomically replaces the running script, and restarts.
 *
 * Only supported for the packaged single-file build (openrmm-agent.js).
 * Service-managed agents exit with a non-zero code so WinSW onfailure /
 * launchd KeepAlive restart them; foreground agents spawn a detached
 * replacement before exiting.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage, ServerMessage } from "@openrmm/shared";
import { getSelfPath } from "./paths.js";

export interface UpdateManager {
  handle(msg: ServerMessage): void;
}

export function createUpdateManager(
  send: (msg: AgentMessage) => void,
  log: (msg: string) => void,
): UpdateManager {
  function runningScript(): string | null {
    const self = getSelfPath();
    // Only the packaged single-file build can self-replace.
    if (path.basename(self) !== "openrmm-agent.js") return null;
    return self;
  }

  async function handle(msg: ServerMessage): Promise<void> {
    if (msg.type !== "update_run") return;

    const fail = (error: string): void => {
      send({ type: "update_status", updateId: msg.updateId, status: "failed", error });
    };

    const script = runningScript();
    if (!script) {
      return fail("self-update requires the packaged single-file build (openrmm-agent.js)");
    }

    try {
      send({ type: "update_status", updateId: msg.updateId, status: "downloading" });
      const res = await fetch(msg.url, { redirect: "follow" });
      if (!res.ok) return fail(`download failed (HTTP ${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());

      send({ type: "update_status", updateId: msg.updateId, status: "verifying" });
      const hash = createHash("sha256").update(data).digest("hex");
      if (hash.toLowerCase() !== msg.sha256.toLowerCase()) {
        return fail("checksum mismatch");
      }

      // Atomic replace: write next to the target, then rename over it.
      const tmp = `${script}.update-${process.pid}`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, script);

      send({ type: "update_status", updateId: msg.updateId, status: "restarting" });
      log(`agent updated, restarting`);

      if (process.env.RMM_AGENT_SERVICE === "1") {
        // WinSW `onfailure` / launchd `KeepAlive` restart us on non-zero exit.
        process.exit(1);
      }

      // Foreground: spawn a detached replacement, then exit cleanly.
      const child = spawn(process.execPath, [script, "run"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
        windowsHide: true,
      });
      child.unref();
      process.exit(0);
    } catch (err) {
      fail(`update error: ${(err as Error).message}`);
    }
  }

  return { handle: (msg) => void handle(msg) };
}
