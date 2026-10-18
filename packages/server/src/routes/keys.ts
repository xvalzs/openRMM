/**
 * Personal API keys. Each user manages their own keys; keys inherit the
 * user's role.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import { randomHex, sha256Hex } from "../crypto.js";
import type { Store } from "../db.js";
import { requireSession } from "./auth.js";
import { audit } from "../audit.js";

export function registerApiKeyRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/api-keys", { preHandler: requireSession }, async (req) => ({
    keys: store.listApiKeys(req.session!.userId),
  }));

  app.post("/api/api-keys", { preHandler: requireSession }, async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: unknown };
    if (typeof name !== "string" || name.trim().length < 1) {
      return reply.code(400).send({ error: "name is required" });
    }
    const token = randomHex(32);
    const info = store.createApiKey(req.session!.userId, name.trim(), sha256Hex(token));
    audit(store, req, "api-key.created", name.trim());
    return reply.code(201).send({ ...info, token });
  });

  app.delete("/api/api-keys/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteApiKey(req.session!.userId, id)) {
      return reply.code(404).send({ error: "key not found" });
    }
    audit(store, req, "api-key.deleted", id);
    return reply.send({ ok: true });
  });
}
