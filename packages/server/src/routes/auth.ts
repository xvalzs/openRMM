/**
 * Dashboard authentication: login/logout/session endpoints.
 * Session resolution itself happens globally in index.ts.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { SessionInfo } from "@openrmm/shared";
import type { Store } from "../db.js";
import { verifyPassword } from "../crypto.js";
import { clearSessionCookie, setSessionCookie, signSession } from "../session.js";
import { audit } from "../audit.js";

interface LoginBody {
  username?: string;
  password?: string;
}

export function registerAuthRoutes(app: FastifyInstance, store: Store, secret: string): void {
  app.post("/api/auth/login", async (req, reply) => {
    const { username, password } = (req.body ?? {}) as LoginBody;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return reply.code(400).send({ error: "username and password are required" });
    }

    const user = store.findUserByUsername(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      audit(store, req, "auth.login_failed", username);
      return reply.code(401).send({ error: "invalid credentials" });
    }

    const { cookie } = signSession(secret, user.id);
    setSessionCookie(reply, cookie);
    audit(store, req, "auth.login", username);
    return reply.send({ userId: user.id, username, role: user.role });
  });

  app.post("/api/auth/logout", async (req, reply) => {
    audit(store, req, "auth.logout");
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: "not authenticated" });
    const body: SessionInfo = {
      userId: req.session.userId,
      username: req.session.username,
      role: req.session.role,
    };
    return reply.send(body);
  });
}

/** Reject requests without a dashboard session. Use as a route preHandler. */
export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.session) {
    await reply.code(401).send({ error: "not authenticated" });
  }
}

/** Reject requests from non-admin sessions. Use as a route preHandler. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireSession(req, reply);
  if (reply.sent) return;
  if (req.session!.role !== "admin") {
    await reply.code(403).send({ error: "admin role required" });
  }
}
