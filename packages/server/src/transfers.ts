/**
 * File transfers between the dashboard and agents.
 *
 * Upload (server → agent): multipart upload lands on disk, then chunks are
 * streamed over the agent's WebSocket with pacing; the agent confirms.
 * Download (agent → server): the agent streams file chunks (ack-paced);
 * the server assembles them on disk for the browser to fetch.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileTransferInfo, ServerMessage } from "@openrmm/shared";
import type { Store } from "./db.js";
import type { AgentSockets } from "./routes/agent.js";

const CHUNK_SIZE = 64 * 1024;
/** Chunks sent per pacing tick while uploading to an agent. */
const CHUNKS_PER_TICK = 8;
const TICK_MS = 25;
const MAX_HISTORY = 50;

function send(socket: ReturnType<AgentSockets["get"]>, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class TransfersService {
  private transfers = new Map<string, FileTransferInfo & { dataDir: string }>();

  constructor(
    private readonly store: Store,
    private readonly sockets: AgentSockets,
    private readonly dataDir: string,
  ) {}

  private register(
    info: Omit<FileTransferInfo, "transferred" | "status" | "error" | "finishedAt" | "createdAt">,
  ): FileTransferInfo {
    const full: FileTransferInfo = {
      ...info,
      transferred: 0,
      status: "pending",
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    this.transfers.set(info.id, { ...full, dataDir: this.dataDir });
    while (this.transfers.size > MAX_HISTORY) {
      const oldest = [...this.transfers.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      if (oldest && (oldest.status === "done" || oldest.status === "failed")) {
        this.transfers.delete(oldest.id);
      } else {
        break;
      }
    }
    return full;
  }

  private update(id: string, patch: Partial<FileTransferInfo>): void {
    const t = this.transfers.get(id);
    if (t) this.transfers.set(id, { ...t, ...patch });
  }

  list(): FileTransferInfo[] {
    return [...this.transfers.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ dataDir: _dataDir, ...rest }) => rest);
  }

  dataDirPath(): string {
    return this.dataDir;
  }

  /** Kick off an upload of a file that already exists on the server. */
  startUpload(
    deviceId: string,
    destPath: string,
    name: string,
    serverFilePath: string,
    size: number,
  ): FileTransferInfo {
    const hostname = this.store.deviceHostname(deviceId);
    const info = this.register({
      id: randomUUID(),
      direction: "upload",
      deviceId,
      deviceHostname: hostname,
      name,
      path: destPath,
      size,
    });
    void this.pushUpload(info.id, serverFilePath, size);
    return info;
  }

  /** Kick off a download of a file from an agent. */
  startDownload(deviceId: string, filePath: string): FileTransferInfo {
    const hostname = this.store.deviceHostname(deviceId);
    const info = this.register({
      id: randomUUID(),
      direction: "download",
      deviceId,
      deviceHostname: hostname,
      name: path.posix.basename(filePath.replace(/\\/g, "/")) || filePath,
      path: filePath,
      size: 0,
    });
    send(this.sockets.get(deviceId), {
      type: "file_request",
      transferId: info.id,
      path: filePath,
    });
    return info;
  }

  downloadPath(transferId: string): string | null {
    const t = this.transfers.get(transferId);
    if (!t || t.direction !== "download" || t.status !== "done") return null;
    return path.join(this.dataDir, "downloads", transferId);
  }

  private async pushUpload(
    transferId: string,
    filePath: string,
    size: number,
  ): Promise<void> {
    const t = this.transfers.get(transferId);
    if (!t) return;
    const socket = this.sockets.get(t.deviceId);
    if (!socket) {
      this.fail(transferId, "device offline");
      return;
    }
    try {
      this.update(transferId, { status: "transferring" });
      send(socket, {
        type: "file_send_start",
        transferId,
        name: t.name,
        size,
        destPath: t.path,
      });
      const fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(CHUNK_SIZE);
      let seq = 0;
      let read = 0;
      for (;;) {
        const n = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
        if (n <= 0) break;
        read += n;
        send(socket, {
          type: "file_send_chunk",
          transferId,
          seq,
          data: buf.subarray(0, n).toString("base64"),
        });
        seq++;
        this.update(transferId, { transferred: read });
        if (seq % CHUNKS_PER_TICK === 0) {
          await new Promise((r) => setTimeout(r, TICK_MS));
        }
      }
      fs.closeSync(fd);
    } catch (err) {
      this.fail(transferId, (err as Error).message);
    }
  }

  /** Agent confirms a finished upload. */
  handleFileSendDone(transferId: string, ok: boolean, error?: string): void {
    const t = this.transfers.get(transferId);
    if (!t) return;
    if (ok) {
      this.update(transferId, { status: "done", transferred: t.size, finishedAt: Date.now() });
      // Clean up the staged server-side copy.
      const staged = path.join(this.dataDir, "uploads", transferId);
      fs.rm(staged, { force: true }, () => undefined);
    } else {
      this.fail(transferId, error ?? "agent reported failure");
    }
  }

  /** A chunk of a download arrived from the agent. */
  handleFileData(transferId: string, data: string): void {
    const t = this.transfers.get(transferId);
    if (!t || t.status === "failed" || t.status === "done") return;
    const dir = path.join(this.dataDir, "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const fd = this.downloadFds.get(transferId) ?? fs.openSync(path.join(dir, transferId), "w");
    this.downloadFds.set(transferId, fd);
    const buf = Buffer.from(data, "base64");
    fs.writeSync(fd, buf);
    this.update(transferId, {
      status: "transferring",
      transferred: (t.transferred ?? 0) + buf.length,
      size: (t.transferred ?? 0) + buf.length,
    });
    send(this.sockets.get(t.deviceId), { type: "file_data_ack", transferId, seq: 0 });
  }

  private downloadFds = new Map<string, number>();

  /** Agent finished a download. */
  handleFileDone(transferId: string, ok: boolean, error?: string): void {
    const fd = this.downloadFds.get(transferId);
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      this.downloadFds.delete(transferId);
    }
    if (ok) {
      this.update(transferId, { status: "done", finishedAt: Date.now() });
    } else {
      this.fail(transferId, error ?? "agent reported failure");
    }
  }

  private fail(transferId: string, error: string): void {
    this.update(transferId, { status: "failed", error, finishedAt: Date.now() });
    const fd = this.downloadFds.get(transferId);
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      this.downloadFds.delete(transferId);
    }
  }

  /** Called when an agent disconnects mid-transfer. */
  onDeviceDisconnected(deviceId: string): void {
    for (const t of this.transfers.values()) {
      if (t.deviceId === deviceId && (t.status === "pending" || t.status === "transferring")) {
        this.fail(t.id, "agent disconnected");
      }
    }
  }
}
