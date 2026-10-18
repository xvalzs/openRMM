/**
 * Agent-side shell sessions: spawns the platform shell with pipes and
 * relays stdin/stdout over the agent's WebSocket channel.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentMessage, ServerMessage } from "@openrmm/shared";

export interface ShellManager {
  handle(msg: ServerMessage): void;
  /** Kill every live shell (e.g. when the server connection drops). */
  closeAll(): void;
}

export function createShellManager(send: (msg: AgentMessage) => void): ShellManager {
  const processes = new Map<string, ChildProcess>();

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "shell_start": {
        // Replace any existing session with the same id.
        const existing = processes.get(msg.sessionId);
        if (existing) existing.kill();

        const child = spawn(msg.shell, msg.args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        processes.set(msg.sessionId, child);

        child.stdout?.on("data", (d: Buffer) => {
          send({ type: "shell_data", sessionId: msg.sessionId, data: d.toString("base64") });
        });
        child.stderr?.on("data", (d: Buffer) => {
          send({ type: "shell_data", sessionId: msg.sessionId, data: d.toString("base64") });
        });
        child.on("error", (err) => {
          send({
            type: "shell_data",
            sessionId: msg.sessionId,
            data: Buffer.from(`\r\n[shell error: ${err.message}]\r\n`).toString("base64"),
          });
        });
        child.on("exit", (code, signal) => {
          processes.delete(msg.sessionId);
          send({
            type: "shell_exit",
            sessionId: msg.sessionId,
            code: signal ? null : code,
          });
        });

        send({ type: "shell_started", sessionId: msg.sessionId, pid: child.pid ?? 0 });
        break;
      }

      case "shell_input": {
        const child = processes.get(msg.sessionId);
        if (!child?.stdin || !child.stdin.writable) return;
        let data = Buffer.from(msg.data, "base64").toString("utf8");
        // Piped shells expect \n line endings, not \r\n.
        if (process.platform === "win32") data = data.replace(/\r\n?/g, "\n");
        child.stdin.write(data);
        break;
      }

      case "shell_end": {
        const child = processes.get(msg.sessionId);
        if (child) {
          processes.delete(msg.sessionId);
          child.kill();
        }
        break;
      }

      default:
        break;
    }
  }

  return {
    handle,
    closeAll: () => {
      for (const child of processes.values()) child.kill();
      processes.clear();
    },
  };
}
