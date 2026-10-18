/**
 * Alert rule evaluation. Runs on every agent heartbeat.
 *
 * A rule fires when its condition has held continuously for `durationSec`.
 * While an alert is active its value is kept fresh; when the condition
 * stops holding, the alert is resolved. State transitions trigger the
 * configured webhook.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type {
  Alert,
  AlertMetric,
  AlertOperator,
  AlertRule,
  Metrics,
} from "@openrmm/shared";
import type { Store } from "./db.js";

/** In-memory pending-violation clock: `${ruleId}|${deviceId}` → since(ms). */
type Violations = Map<string, number>;

export class AlertService {
  private violations: Violations = new Map();

  constructor(private readonly store: Store) {}

  evaluate(deviceId: string, metrics: Metrics, now: number = Date.now()): void {
    const rules = this.store
      .listAlertRules()
      .filter((r) => r.enabled && (!r.deviceId || r.deviceId === deviceId));

    for (const rule of rules) {
      const value = metricValue(rule.metric, metrics);
      if (value === null) continue;

      const key = `${rule.id}|${deviceId}`;
      const active = this.store.findActiveAlert(rule.id, deviceId);

      if (compare(value, rule.operator, rule.threshold)) {
        if (active) {
          this.store.touchAlert(active.id, value, now);
        } else {
          const since = this.violations.get(key) ?? now;
          this.violations.set(key, since);
          if (now - since >= rule.durationSec * 1000) {
            this.violations.delete(key);
            const row = this.store.createAlert(rule, deviceId, value, now);
            void this.fireTransition("alert.fired", {
              ...alertFromRow(this.store, row),
            });
          }
        }
      } else {
        this.violations.delete(key);
        if (active) {
          this.store.resolveAlert(active.id, now);
          void this.fireTransition("alert.resolved", {
            ...alertFromRow(this.store, { ...active, state: "resolved", resolved_at: now }),
          });
        }
      }
    }
  }

  private async fireTransition(event: string, alert: Alert): Promise<void> {
    const url = this.store.getSetting("alert_webhook_url")?.trim();
    if (!url) return;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event, alert }),
      });
      if (!res.ok) {
        console.warn(`[alerts] webhook ${url} returned HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`[alerts] webhook ${url} failed: ${(err as Error).message}`);
    }
  }
}

export function metricValue(
  metric: AlertMetric,
  metrics: Metrics,
): number | null {
  switch (metric) {
    case "cpu_usage":
      return metrics.cpuUsage;
    case "mem_pct":
      return metrics.memTotal > 0 ? (metrics.memUsed / metrics.memTotal) * 100 : null;
    case "disk_pct": {
      const drive = metrics.drives[0];
      if (!drive || drive.total <= 0) return null;
      return ((drive.total - drive.free) / drive.total) * 100;
    }
  }
}

function compare(
  value: number,
  operator: AlertOperator,
  threshold: number,
): boolean {
  switch (operator) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
  }
}

function alertFromRow(
  store: Store,
  row: {
    id: string;
    rule_id: string;
    device_id: string;
    value: number;
    state: string;
    created_at: number;
    last_seen_at: number;
    resolved_at: number | null;
  },
): Alert {
  const rule = store.getAlertRule(row.rule_id);
  const hostname = store.deviceHostname(row.device_id);
  const metric = (rule?.metric ?? "cpu_usage") as AlertMetric;
  const operator = (rule?.operator ?? ">") as AlertOperator;
  const threshold = rule?.threshold ?? 0;
  const label: Record<string, string> = {
    cpu_usage: "CPU usage",
    mem_pct: "memory usage",
    disk_pct: "disk usage",
  };
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: rule?.name ?? "deleted rule",
    deviceId: row.device_id,
    deviceHostname: hostname,
    metric,
    operator,
    threshold,
    value: row.value,
    message: `${hostname}: ${label[metric] ?? metric} ${operator} ${threshold}% (current ${row.value.toFixed(1)}%)`,
    state: row.state as Alert["state"],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
  };
}
