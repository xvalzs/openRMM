/**
 * Process management endpoints (admin only).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { Store } from "../db.js";
import type { ProcessesService } from "../processes.js";
import { requireAdmin } from "./auth.js";
import { audit } from "../audit.js";

export function registerProcessRoutes(
  app: FastifyInstance,
  store: Store,
  processes: ProcessesService,
): void {
  // Cached list; POST refresh triggers a fresh one.
  app.get("/api/devices/:id/processes", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cached = processes.get(id);
    if (!cached) return reply.code(404).send({ error: "no process list yet; refresh first" });
    return { ...cached };
  });

  app.post("/api/devices/:id/processes/refresh", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = store.getDevice(id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!processes.refresh(id)) {
      return reply.code(409).send({ error: "device is offline" });
    }
    return reply.send({ ok: true });
  });

  app.post("/api/devices/:id/processes/:pid/kill", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const pid = Number((req.params as { pid: string }).pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return reply.code(400).send({ error: "invalid pid" });
    }
    const device = store.getDevice(id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!processes.kill(id, pid)) {
      return reply.code(409).send({ error: "device is offline" });
    }
    audit(store, req, "process.kill", `${device.hostname} pid ${pid}`);
    return reply.send({ ok: true });
  });
}
