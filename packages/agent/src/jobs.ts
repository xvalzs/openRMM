/**
 * Agent-side job execution: runs scripts dispatched by the server,
 * streaming stdout/stderr and reporting the exit status.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentMessage, ServerMessage } from "@openrmm/shared";

export interface JobManager {
  handle(msg: ServerMessage): void;
  closeAll(): void;
}

interface RunningJob {
  proc: ChildProcess;
  timedOut: boolean;
}

export function createJobManager(send: (msg: AgentMessage) => void): JobManager {
  const running = new Map<string, RunningJob>();

  function spawnScript(script: string): ChildProcess {
    if (process.platform === "win32") {
      return spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    }
    return spawn("/bin/bash", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "job_run": {
        const existing = running.get(msg.jobId);
        if (existing) existing.proc.kill();

        const proc = spawnScript(msg.script);
        const entry: RunningJob = { proc, timedOut: false };
        running.set(msg.jobId, entry);

        const timer = setTimeout(() => {
          entry.timedOut = true;
          proc.kill();
        }, msg.timeoutSec * 1000);

        proc.stdout?.on("data", (d: Buffer) => {
          send({ type: "job_output", jobId: msg.jobId, stream: "stdout", data: d.toString("base64") });
        });
        proc.stderr?.on("data", (d: Buffer) => {
          send({ type: "job_output", jobId: msg.jobId, stream: "stderr", data: d.toString("base64") });
        });
        proc.on("error", (err) => {
          send({
            type: "job_output",
            jobId: msg.jobId,
            stream: "stderr",
            data: Buffer.from(`[job error: ${err.message}]\n`).toString("base64"),
          });
        });
        proc.on("exit", (code, signal) => {
          clearTimeout(timer);
          running.delete(msg.jobId);
          send({
            type: "job_done",
            jobId: msg.jobId,
            exitCode: signal && !entry.timedOut ? null : code,
            timedOut: entry.timedOut,
          });
        });
        break;
      }

      case "job_cancel": {
        const entry = running.get(msg.jobId);
        if (entry) {
          running.delete(msg.jobId);
          entry.proc.kill();
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
      for (const entry of running.values()) entry.proc.kill();
      running.clear();
    },
  };
}
