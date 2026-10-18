/**
 * Stateless signed-cookie sessions for the dashboard.
 * Cookie value: `userId.expiry.signature` with HMAC-SHA256 over
 * `userId.expiry`, keyed by the server session secret.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { hmacHex, safeEqualHex } from "./crypto.js";

export const SESSION_COOKIE = "rmm_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface Session {
  userId: number;
  username: string;
}

declare module "fastify" {
  interface FastifyRequest {
    /** Populated on every request by the session hook in index.ts. */
    session: Session | null;
  }
}

export function signSession(
  secret: string,
  userId: number,
): { cookie: string; expiry: number } {
  const expiry = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${expiry}`;
  const sig = hmacHex(secret, payload);
  return { cookie: `${payload}.${sig}`, expiry };
}

export function verifySession(
  secret: string,
  cookieValue: string | undefined,
): number | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;
  const [userIdStr, expiryStr, sig] = parts as [string, string, string];
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;
  const expected = hmacHex(secret, `${userIdStr}.${expiryStr}`);
  if (!safeEqualHex(expected, sig)) return null;
  const userId = Number(userIdStr);
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

export function setSessionCookie(reply: FastifyReply, cookieValue: string): void {
  reply.setCookie(SESSION_COOKIE, cookieValue, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: reply.request.protocol === "https",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionCookie(req: FastifyRequest): string | undefined {
  const value = req.cookies?.[SESSION_COOKIE];
  return typeof value === "string" ? value : undefined;
}
