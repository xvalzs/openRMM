/**
 * File transfer endpoints (admin only).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Store } from "../db.js";
import type { TransfersService } from "../transfers.js";
import { requireAdmin } from "./auth.js";
import { audit } from "../audit.js";

export function registerFileRoutes(
  app: FastifyInstance,
  store: Store,
  transfers: TransfersService,
): void {
  app.get("/api/files", { preHandler: requireAdmin }, async () => ({
    transfers: transfers.list(),
  }));

  // Upload: multipart form with `file`, `deviceId`, `destPath` fields.
  app.post("/api/files/upload", { preHandler: requireAdmin }, async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "missing file part" });
    const deviceId = (data.fields.deviceId as { value?: string } | undefined)?.value;
    const destPath = (data.fields.destPath as { value?: string } | undefined)?.value;
    if (!deviceId || !destPath) {
      return reply.code(400).send({ error: "deviceId and destPath fields are required" });
    }
    const device = store.getDevice(deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.online) return reply.code(409).send({ error: "device is offline" });

    const transferId = randomUUID();
    const dir = path.join(transfers.dataDirPath(), "uploads");
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, transferId);
    await pipeline(data.file, fs.createWriteStream(staged));
    const size = fs.statSync(staged).size;

    const info = transfers.startUpload(
      deviceId,
      destPath,
      data.filename,
      staged,
      size,
    );
    audit(store, req, "file.upload", `${device.hostname} ← ${data.filename}`, {
      destPath,
      size,
    });
    return reply.code(201).send(info);
  });

  // Download from an agent.
  app.post("/api/files/download", { preHandler: requireAdmin }, async (req, reply) => {
    const { deviceId, path: filePath } = (req.body ?? {}) as {
      deviceId?: string;
      path?: string;
    };
    if (!deviceId || !filePath) {
      return reply.code(400).send({ error: "deviceId and path are required" });
    }
    const device = store.getDevice(deviceId);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.online) return reply.code(409).send({ error: "device is offline" });

    const info = transfers.startDownload(deviceId, filePath);
    audit(store, req, "file.download", `${device.hostname} → ${filePath}`);
    return reply.code(201).send(info);
  });

  // Fetch a completed download.
  app.get("/api/files/downloads/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const filePath = transfers.downloadPath(id);
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "download not found or not finished" });
    }
    const transfer = transfers.list().find((t) => t.id === id);
    if (transfer) {
      reply.header(
        "content-disposition",
        `attachment; filename="${transfer.name.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      );
    }
    return reply.send(fs.createReadStream(filePath));
  });
}
