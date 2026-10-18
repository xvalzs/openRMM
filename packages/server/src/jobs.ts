/**
 * Job dispatch: fan a script out to targeted agents over their WebSocket
 * channels, collect streaming output, and track per-device results.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomUUID } from "node:crypto";
import type {
  JobCreateInput,
  JobSummary,
  ServerMessage,
} from "@openrmm/shared";
import type { Store } from "./db.js";
import type { AgentSockets } from "./routes/agent.js";

const DEFAULT_TIMEOUT_SEC = 60;
const TIMEOUT_GRACE_MS = 30_000;

function send(socket: ReturnType<AgentSockets["get"]>, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class JobsService {
  constructor(
    private readonly store: Store,
    private readonly sockets: AgentSockets,
  ) {}

  dispatch(input: JobCreateInput, createdBy: string): JobSummary {
    const id = randomUUID();
    const timeoutSec = clampTimeout(input.timeoutSec);
    this.store.createJob(id, input.name, input.script, timeoutSec, createdBy);

    const targets =
      input.deviceIds && input.deviceIds.length > 0
        ? input.deviceIds
        : this.store
            .listDevices()
            .filter((d) => d.online)
            .map((d) => d.id);

    let dispatched = 0;
    for (const deviceId of new Set(targets)) {
      const device = this.store.getDevice(deviceId);
      const socket = this.sockets.get(deviceId);
      if (!device || !device.online || !socket) {
        this.store.addJobResult(id, deviceId ?? "", "skipped", "device offline");
        if (!device) {
          // Unknown id: still record the skip so the user sees it.
          this.store.addJobResult(id, deviceId, "skipped", "unknown device");
        }
        continue;
      }
      this.store.addJobResult(id, deviceId, "pending");
      send(socket, {
        type: "job_run",
        jobId: id,
        script: input.script,
        timeoutSec,
      });
      dispatched++;
    }

    if (dispatched === 0) this.store.setJobStatus(id, "completed");
    return this.store.getJob(id)!;
  }

  /** Agent-side messages for jobs, called from the agent WS handler where
   *  the deviceId is in scope. */
  onOutputForDevice(
    jobId: string,
    deviceId: string,
    stream: "stdout" | "stderr",
    data: string,
  ): void {
    const row = this.store.db
      .prepare(
        "SELECT status FROM job_results WHERE job_id = ? AND device_id = ?",
      )
      .get(jobId, deviceId) as { status: string } | undefined;
    if (!row) return;
    if (row.status === "pending") {
      this.store.markJobResultStarted(jobId, deviceId);
    }
    if (row.status === "running" || row.status === "pending") {
      // The agent sends output base64-encoded; store decoded text.
      const text = Buffer.from(data, "base64").toString("utf8");
      this.store.appendJobOutput(jobId, deviceId, stream, text);
    }
  }

  onDoneForDevice(
    jobId: string,
    deviceId: string,
    exitCode: number | null,
    timedOut: boolean,
  ): void {
    const row = this.store.db
      .prepare(
        "SELECT status FROM job_results WHERE job_id = ? AND device_id = ?",
      )
      .get(jobId, deviceId) as { status: string } | undefined;
    if (!row) return;
    if (row.status !== "pending" && row.status !== "running") return;
    const status = timedOut ? "timeout" : exitCode === 0 ? "success" : "failed";
    this.store.finishJobResult(jobId, deviceId, status, exitCode);
    this.recomputeJob(jobId);
  }

  /** Called when an agent disconnects: fail its in-flight results. */
  onDeviceDisconnected(deviceId: string): void {
    for (const { job_id } of this.store.listActiveResultsForDevice(deviceId)) {
      this.store.finishJobResult(job_id, deviceId, "failed", null, "agent disconnected");
      this.recomputeJob(job_id);
    }
  }

  cancel(jobId: string): boolean {
    const job = this.store.getJob(jobId);
    if (!job) return false;
    for (const deviceId of this.store.listActiveJobResultDevices(jobId)) {
      send(this.sockets.get(deviceId), { type: "job_cancel", jobId });
    }
    this.store.finishAllJobResults(jobId, "cancelled", "job cancelled");
    this.store.setJobStatus(jobId, "cancelled");
    return true;
  }

  /** Periodic sweep: fail results that never finished in time. */
  sweepTimeouts(now: number = Date.now()): void {
    const rows = this.store.db
      .prepare(
        `SELECT r.job_id, r.device_id, r.status, r.started_at, j.timeout_sec
         FROM job_results r JOIN jobs j ON j.id = r.job_id
         WHERE j.status = 'running' AND r.status IN ('pending', 'running')`,
      )
      .all() as unknown as {
      job_id: string;
      device_id: string;
      status: string;
      started_at: number | null;
      timeout_sec: number;
    }[];
    for (const row of rows) {
      const deadline = row.timeout_sec * 1000 + TIMEOUT_GRACE_MS;
      if (row.started_at !== null && now - row.started_at > deadline) {
        this.store.finishJobResult(
          row.job_id,
          row.device_id,
          "timeout",
          null,
          "job timed out",
        );
        this.recomputeJob(row.job_id);
      }
    }
  }

  private recomputeJob(jobId: string): void {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== "running") return;
    if (this.store.listActiveJobResultDevices(jobId).length === 0) {
      this.store.setJobStatus(jobId, "completed");
    }
  }
}

function clampTimeout(value: number | undefined): number {
  const v = Math.round(Number(value ?? DEFAULT_TIMEOUT_SEC));
  if (!Number.isFinite(v)) return DEFAULT_TIMEOUT_SEC;
  return Math.max(5, Math.min(3600, v));
}
