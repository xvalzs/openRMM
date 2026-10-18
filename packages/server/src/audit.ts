/**
 * Audit log helper. Appends security-relevant actions to the audit_log
 * table, attributed to the current session.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyRequest } from "fastify";
import type { Store } from "./db.js";

export function audit(
  store: Store,
  req: FastifyRequest,
  action: string,
  target?: string | null,
  meta?: unknown,
): void {
  try {
    store.addAuditEntry({
      username: req.session?.username ?? "unknown",
      userId: req.session?.userId ?? null,
      action,
      target: target ?? null,
      ip: req.ip ?? null,
      meta: meta === undefined ? null : JSON.stringify(meta),
    });
  } catch (err) {
    // Auditing must never break the request path.
    console.warn(`[audit] failed to record ${action}: ${(err as Error).message}`);
  }
}
