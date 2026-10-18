/**
 * Update management endpoints: OS update status, agent update dispatch.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { UpdateDispatchInput } from "@openrmm/shared";
import type { Store } from "../db.js";
import type { UpdatesService } from "../updates.js";
import { requireAdmin, requireSession } from "./auth.js";
import { audit } from "../audit.js";

function parseDispatchBody(body: unknown): UpdateDispatchInput | { error: string } {
  const b = (body ?? {}) as Partial<UpdateDispatchInput>;
  if (typeof b.url !== "string" || !/^https?:\/\//.test(b.url)) {
    return { error: "url must start with http:// or https://" };
  }
  if (typeof b.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(b.sha256)) {
    return { error: "sha256 must be a 64-character hex digest" };
  }
  if (
    b.deviceIds !== undefined &&
    b.deviceIds !== null &&
    (!Array.isArray(b.deviceIds) || b.deviceIds.some((d) => typeof d !== "string"))
  ) {
    return { error: "deviceIds must be an array of strings or null" };
  }
  return { url: b.url, sha256: b.sha256.toLowerCase(), deviceIds: b.deviceIds ?? null };
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  store: Store,
  updates: UpdatesService,
): void {
  app.get("/api/updates/info", { preHandler: requireSession }, async () => ({
    devices: store.listDeviceUpdateInfo(),
  }));

  app.get("/api/updates", { preHandler: requireSession }, async () => ({
    updates: store.listAgentUpdates(),
  }));

  app.post("/api/updates", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = parseDispatchBody(req.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const rows = updates.dispatch(parsed);
    audit(store, req, "update.dispatched", `${rows.length} devices`, {
      url: parsed.url,
    });
    return reply.code(201).send({ updates: rows });
  });
}
