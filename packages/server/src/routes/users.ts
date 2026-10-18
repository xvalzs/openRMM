/**
 * User management (admin only).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { UserCreateInput, UserRole } from "@openrmm/shared";
import type { Store } from "../db.js";
import { requireAdmin } from "./auth.js";

const ROLES: UserRole[] = ["admin", "operator"];

export function registerUserRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/users", { preHandler: requireAdmin }, async () => ({
    users: store.listUsers(),
  }));

  app.post("/api/users", { preHandler: requireAdmin }, async (req, reply) => {
    const { username, password, role } = (req.body ?? {}) as Partial<UserCreateInput>;
    if (typeof username !== "string" || username.trim().length < 3) {
      return reply.code(400).send({ error: "username must be at least 3 characters" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    if (!ROLES.includes(role as UserRole)) {
      return reply.code(400).send({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    const name = username.trim();
    if (store.findUserByUsername(name)) {
      return reply.code(409).send({ error: "username already exists" });
    }
    return reply.code(201).send(store.createUser(name, password, role as UserRole));
  });

  app.put("/api/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = Number(id);
    const { password, role } = (req.body ?? {}) as {
      password?: string;
      role?: UserRole;
    };
    const existing = store.findUserById(userId);
    if (!existing) return reply.code(404).send({ error: "user not found" });

    if (password !== undefined && (typeof password !== "string" || password.length < 8)) {
      return reply.code(400).send({ error: "password must be at least 8 characters" });
    }
    if (role !== undefined && !ROLES.includes(role)) {
      return reply.code(400).send({ error: `role must be one of: ${ROLES.join(", ")}` });
    }
    if (role !== undefined && role !== existing.role) {
      if (userId === req.session!.userId) {
        return reply.code(400).send({ error: "you cannot change your own role" });
      }
      if (existing.role === "admin" && store.countAdmins() <= 1) {
        return reply.code(400).send({ error: "cannot demote the last admin" });
      }
    }
    store.updateUser(userId, { password, role });
    return reply.send(store.findUserById(userId));
  });

  app.delete("/api/users/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const userId = Number((req.params as { id: string }).id);
    const existing = store.findUserById(userId);
    if (!existing) return reply.code(404).send({ error: "user not found" });
    if (userId === req.session!.userId) {
      return reply.code(400).send({ error: "you cannot delete yourself" });
    }
    if (existing.role === "admin" && store.countAdmins() <= 1) {
      return reply.code(400).send({ error: "cannot delete the last admin" });
    }
    store.deleteUser(userId);
    return reply.send({ ok: true });
  });
}
