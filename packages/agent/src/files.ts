/**
 * Agent-side file transfers.
 *
 * Upload (server → agent): the server sends chunks; we write them to the
 * destination and confirm when complete.
 * Download (agent → server): we stream a file back in chunks, paced by
 * per-chunk acknowledgements from the server.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentMessage, ServerMessage } from "@openrmm/shared";

const CHUNK_SIZE = 64 * 1024;
const MAX_DOWNLOAD_SIZE = 512 * 1024 * 1024; // 512 MiB safety cap

export interface FileManager {
  handle(msg: ServerMessage): void;
  closeAll(): void;
}

interface UploadState {
  fd: number;
  expectedSize: number;
  received: number;
  destPath: string;
}

export function createFileManager(send: (msg: AgentMessage) => void): FileManager {
  const uploads = new Map<string, UploadState>();
  const downloads = new Map<string, { fd: number; sent: number }>();

  function cleanupUpload(transferId: string): void {
    const state = uploads.get(transferId);
    if (state) {
      try {
        fs.closeSync(state.fd);
      } catch {
        /* already closed */
      }
      uploads.delete(transferId);
    }
  }

  function handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "file_send_start": {
        cleanupUpload(msg.transferId);
        try {
          fs.mkdirSync(path.dirname(msg.destPath), { recursive: true });
          const fd = fs.openSync(msg.destPath, "w");
          uploads.set(msg.transferId, {
            fd,
            expectedSize: msg.size,
            received: 0,
            destPath: msg.destPath,
          });
        } catch (err) {
          send({
            type: "file_send_done",
            transferId: msg.transferId,
            ok: false,
            error: `cannot write to ${msg.destPath}: ${(err as Error).message}`,
          });
        }
        break;
      }

      case "file_send_chunk": {
        const state = uploads.get(msg.transferId);
        if (!state) return;
        try {
          const buf = Buffer.from(msg.data, "base64");
          fs.writeSync(state.fd, buf);
          state.received += buf.length;
          if (state.received >= state.expectedSize) {
            cleanupUpload(msg.transferId);
            send({ type: "file_send_done", transferId: msg.transferId, ok: true });
          }
        } catch (err) {
          cleanupUpload(msg.transferId);
          send({
            type: "file_send_done",
            transferId: msg.transferId,
            ok: false,
            error: (err as Error).message,
          });
        }
        break;
      }

      case "file_request": {
        try {
          const stat = fs.statSync(msg.path);
          if (!stat.isFile()) throw new Error("not a regular file");
          if (stat.size > MAX_DOWNLOAD_SIZE) throw new Error("file too large");
          const fd = fs.openSync(msg.path, "r");
          downloads.set(msg.transferId, { fd, sent: 0 });
          sendChunks(msg.transferId, fd, stat.size);
        } catch (err) {
          send({
            type: "file_done",
            transferId: msg.transferId,
            ok: false,
            error: (err as Error).message,
          });
        }
        break;
      }

      case "file_data_ack": {
        const state = downloads.get(msg.transferId);
        if (!state) return;
        sendChunks(msg.transferId, state.fd, undefined);
        break;
      }

      case "file_cancel": {
        cleanupUpload(msg.transferId);
        const dl = downloads.get(msg.transferId);
        if (dl) {
          try {
            fs.closeSync(dl.fd);
          } catch {
            /* ignore */
          }
          downloads.delete(msg.transferId);
        }
        break;
      }

      default:
        break;
    }
  }

  function sendChunks(
    transferId: string,
    fd: number,
    totalSize: number | undefined,
  ): void {
    // Send one chunk per call; the server acks each chunk, pacing the flow.
    const buf = Buffer.alloc(CHUNK_SIZE);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, null);
    } catch (err) {
      fs.closeSync(fd);
      downloads.delete(transferId);
      send({
        type: "file_done",
        transferId,
        ok: false,
        error: (err as Error).message,
      });
      return;
    }
    if (bytesRead <= 0) {
      fs.closeSync(fd);
      downloads.delete(transferId);
      send({ type: "file_done", transferId, ok: true });
      return;
    }
    const state = downloads.get(transferId);
    if (state) state.sent += bytesRead;
    send({
      type: "file_data",
      transferId,
      seq: state ? state.sent / CHUNK_SIZE : 0,
      data: buf.subarray(0, bytesRead).toString("base64"),
    });
    void totalSize;
  }

  return {
    handle,
    closeAll: () => {
      for (const transferId of [...uploads.keys()]) cleanupUpload(transferId);
      for (const [transferId, state] of downloads) {
        try {
          fs.closeSync(state.fd);
        } catch {
          /* ignore */
        }
        downloads.delete(transferId);
      }
    },
  };
}
