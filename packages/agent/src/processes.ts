/**
 * Agent-side process management: list and kill processes.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { execFile } from "node:child_process";
import type { AgentMessage, ProcessInfo, ServerMessage } from "@openrmm/shared";

export interface ProcessManager {
  handle(msg: ServerMessage): void;
}

const LIST_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 15_000;

export function createProcessManager(send: (msg: AgentMessage) => void): ProcessManager {
  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "process_list":
        listProcesses()
          .then((processes) => {
            send({ type: "process_list_result", processes });
          })
          .catch((err: Error) => {
            send({
              type: "process_list_result",
              processes: [],
            });
            void err;
          });
        break;

      case "process_kill":
        killProcess(msg.pid)
          .then(() => send({ type: "process_kill_result", pid: msg.pid, ok: true }))
          .catch((err: Error) =>
            send({ type: "process_kill_result", pid: msg.pid, ok: false, error: err.message }),
          );
        break;

      default:
        break;
    }
  }

  return { handle };
}

function listProcesses(): Promise<ProcessInfo[]> {
  const { command, args, parse } =
    process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Process | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress",
          ],
          parse: (out: string): ProcessInfo[] => {
            const trimmed = out.trim();
            if (!trimmed) return [];
            const items = JSON.parse(trimmed) as
              | { Id: number; ProcessName: string; WorkingSet64: number | null }[]
              | { Id: number; ProcessName: string; WorkingSet64: number | null };
            const list = Array.isArray(items) ? items : [items];
            return list
              .filter((p) => p && typeof p.Id === "number")
              .map((p) => ({
                pid: p.Id,
                name: String(p.ProcessName),
                memBytes: typeof p.WorkingSet64 === "number" ? p.WorkingSet64 : null,
              }));
          },
        }
      : {
          command: "/bin/ps",
          args: ["-axo", "pid=,comm=,rss="],
          parse: (out: string): ProcessInfo[] =>
            out
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(/\s+/);
                const pid = Number(parts[0]);
                const rssKb = Number(parts[2]);
                return {
                  pid,
                  name: parts.slice(1, -1).join(" ") || parts[1] || "?",
                  memBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
                };
              })
              .filter((p) => Number.isInteger(p.pid)),
        };

  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: LIST_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      try {
        resolve(parse(stdout));
      } catch (parseErr) {
        reject(parseErr instanceof Error ? parseErr : new Error(String(parseErr)));
      }
    });
  });
}

function killProcess(pid: number): Promise<void> {
  const { command, args } =
    process.platform === "win32"
      ? {
          command: "powershell.exe",
          args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force`],
        }
      : { command: "/bin/kill", args: ["-9", String(pid)] };

  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: KILL_TIMEOUT_MS, windowsHide: true }, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}
