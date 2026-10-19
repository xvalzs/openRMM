/**
 * Agent-side shell sessions.
 *
 * Uses a real PTY when @lydell/node-pty is available (full terminal
 * emulation: ANSI colors, Ctrl+C, interactive TUIs, resize) and falls back
 * to piped spawn otherwise. The wire protocol is identical either way.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import type { AgentMessage, ServerMessage } from "@openrmm/shared";

export interface ShellManager {
  handle(msg: ServerMessage): void;
  /** Kill every live shell (e.g. when the server connection drops). */
  closeAll(): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols: number;
      rows: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): {
    onData(cb: (data: string) => void): void;
    onExit(cb: (exit: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    readonly pid: number;
  };
}

function loadPty(): PtyModule | null {
  try {
    // Resolves relative to this file: the bundled agent ships node-pty in a
    // node_modules folder next to itself; the repo build walks up to the
    // workspace node_modules.
    const req = createRequire(import.meta.url);
    return req("@lydell/node-pty") as PtyModule;
  } catch {
    return null;
  }
}

export function createShellManager(send: (msg: AgentMessage) => void): ShellManager {
  const pty = loadPty();
  const processes = new Map<
    string,
    | { kind: "pty"; proc: ReturnType<PtyModule["spawn"]> }
    | { kind: "pipe"; proc: ChildProcess }
  >();

  function shellCommand(): { file: string; args: string[] } {
    if (process.platform === "win32") {
      return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile"] };
    }
    return { file: "/bin/bash", args: ["--noprofile", "--norc"] };
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "shell_start": {
        const existing = processes.get(msg.sessionId);
        if (existing) {
          if (existing.kind === "pty") existing.proc.kill();
          else existing.proc.kill();
        }

        const { file, args } = shellCommand();
        if (pty) {
          const proc = pty.spawn(file, args, {
            cols: 100,
            rows: 30,
            env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
          });
          processes.set(msg.sessionId, { kind: "pty", proc });
          proc.onData((data) => {
            send({
              type: "shell_data",
              sessionId: msg.sessionId,
              data: Buffer.from(data, "utf8").toString("base64"),
            });
          });
          proc.onExit(({ exitCode }) => {
            processes.delete(msg.sessionId);
            send({
              type: "shell_exit",
              sessionId: msg.sessionId,
              code: exitCode === 0 ? 0 : exitCode,
            });
          });
          send({ type: "shell_started", sessionId: msg.sessionId, pid: proc.pid });
          return;
        }

        const child = spawn(file, args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        processes.set(msg.sessionId, { kind: "pipe", proc: child });
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
          send({ type: "shell_exit", sessionId: msg.sessionId, code: signal ? null : code });
        });
        send({ type: "shell_started", sessionId: msg.sessionId, pid: child.pid ?? 0 });
        break;
      }

      case "shell_input": {
        const entry = processes.get(msg.sessionId);
        if (!entry) return;
        const data = Buffer.from(msg.data, "base64").toString("utf8");
        if (entry.kind === "pty") {
          entry.proc.write(data);
        } else if (entry.proc.stdin && entry.proc.stdin.writable) {
          let text = data;
          if (process.platform === "win32") text = text.replace(/\r\n?/g, "\n");
          entry.proc.stdin.write(text);
        }
        break;
      }

      case "shell_resize": {
        const entry = processes.get(msg.sessionId);
        if (entry?.kind === "pty") {
          entry.proc.resize(msg.cols, msg.rows);
        }
        break;
      }

      case "shell_end": {
        const entry = processes.get(msg.sessionId);
        if (entry) {
          processes.delete(msg.sessionId);
          if (entry.kind === "pty") entry.proc.kill();
          else entry.proc.kill();
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
      for (const entry of processes.values()) {
        if (entry.kind === "pty") entry.proc.kill();
        else entry.proc.kill();
      }
      processes.clear();
    },
  };
}
