/**
 * Audit log (admin only).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { Store } from "../db.js";
import { requireAdmin } from "./auth.js";

export function registerAuditRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/audit", { preHandler: requireAdmin }, async (req) => {
    const { limit = "200" } = req.query as { limit?: string };
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return { entries: store.listAuditEntries(n) };
  });
}
