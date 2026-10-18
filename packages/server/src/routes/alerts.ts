/**
 * Alert rule management and the alert feed.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type {
  AlertListResponse,
  AlertMetric,
  AlertOperator,
  AlertRuleInput,
  AlertSettings,
} from "@openrmm/shared";
import type { Store } from "../db.js";
import { requireAdmin, requireSession } from "./auth.js";

const METRICS: AlertMetric[] = ["cpu_usage", "mem_pct", "disk_pct"];
const OPERATORS: AlertOperator[] = [">", ">=", "<", "<="];

function parseRuleBody(body: unknown): AlertRuleInput | { error: string } {
  const b = (body ?? {}) as Partial<AlertRuleInput>;
  if (typeof b.name !== "string" || !b.name.trim()) {
    return { error: "name is required" };
  }
  if (!METRICS.includes(b.metric as AlertMetric)) {
    return { error: `metric must be one of: ${METRICS.join(", ")}` };
  }
  if (!OPERATORS.includes(b.operator as AlertOperator)) {
    return { error: `operator must be one of: ${OPERATORS.join(", ")}` };
  }
  if (typeof b.threshold !== "number" || !Number.isFinite(b.threshold)) {
    return { error: "threshold must be a number" };
  }
  const durationSec = Number(b.durationSec ?? 0);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    return { error: "durationSec must be a non-negative number" };
  }
  if (b.deviceId !== undefined && b.deviceId !== null && typeof b.deviceId !== "string") {
    return { error: "deviceId must be a string or null" };
  }
  return {
    name: b.name.trim(),
    deviceId: b.deviceId ?? null,
    metric: b.metric as AlertMetric,
    operator: b.operator as AlertOperator,
    threshold: b.threshold,
    durationSec,
    enabled: b.enabled !== false,
  };
}

export function registerAlertRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/alert-rules", { preHandler: requireSession }, async () => ({
    rules: store.listAlertRules(),
  }));

  app.post("/api/alert-rules", { preHandler: requireSession }, async (req, reply) => {
    const parsed = parseRuleBody(req.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send(store.createAlertRule(parsed));
  });

  app.put("/api/alert-rules/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Partial<AlertRuleInput>;
    const parsed = parseRuleBody({
      name: body.name ?? "placeholder",
      metric: body.metric ?? "cpu_usage",
      operator: body.operator ?? ">",
      threshold: body.threshold ?? 0,
      durationSec: body.durationSec ?? 0,
      deviceId: body.deviceId,
      enabled: body.enabled,
    });
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    // parseRuleBody filled defaults; apply only provided fields.
    const patch: Partial<AlertRuleInput> = {};
    if (body.name !== undefined) patch.name = parsed.name;
    if (body.metric !== undefined) patch.metric = parsed.metric;
    if (body.operator !== undefined) patch.operator = parsed.operator;
    if (body.threshold !== undefined) patch.threshold = parsed.threshold;
    if (body.durationSec !== undefined) patch.durationSec = parsed.durationSec;
    if (body.enabled !== undefined) patch.enabled = parsed.enabled;
    if (body.deviceId !== undefined) patch.deviceId = parsed.deviceId;
    const updated = store.updateAlertRule(id, patch);
    if (!updated) return reply.code(404).send({ error: "rule not found" });
    return reply.send(updated);
  });

  app.delete("/api/alert-rules/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteAlertRule(id)) {
      return reply.code(404).send({ error: "rule not found" });
    }
    return reply.send({ ok: true });
  });

  app.get("/api/alerts", { preHandler: requireSession }, async (req) => {
    const { state = "active", limit = "100" } = req.query as {
      state?: string;
      limit?: string;
    };
    const s = state === "resolved" || state === "all" ? state : "active";
    const n = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const body: AlertListResponse = { alerts: store.listAlerts(s, n) };
    return body;
  });

  app.get("/api/alert-settings", { preHandler: requireSession }, async () => {
    const body: AlertSettings = {
      webhookUrl: store.getSetting("alert_webhook_url") ?? "",
    };
    return body;
  });

  app.put("/api/alert-settings", { preHandler: requireAdmin }, async (req, reply) => {
    const { webhookUrl } = (req.body ?? {}) as { webhookUrl?: unknown };
    if (webhookUrl !== undefined && typeof webhookUrl !== "string") {
      return reply.code(400).send({ error: "webhookUrl must be a string" });
    }
    const url = (webhookUrl ?? "").trim();
    if (url && !/^https?:\/\//.test(url)) {
      return reply.code(400).send({ error: "webhookUrl must start with http:// or https://" });
    }
    store.setSetting("alert_webhook_url", url);
    const body: AlertSettings = { webhookUrl: url };
    return reply.send(body);
  });
}
