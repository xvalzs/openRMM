import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Alert, AlertRule, AlertMetric, AlertOperator, Device } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatDateTime } from "./format.js";

const METRICS: { value: AlertMetric; label: string }[] = [
  { value: "cpu_usage", label: "CPU usage %" },
  { value: "mem_pct", label: "Memory usage %" },
  { value: "disk_pct", label: "Disk usage %" },
];

const OPERATORS: AlertOperator[] = [">", ">=", "<", "<="];

interface AlertsProps {
  isAdmin: boolean;
}

interface RuleForm {
  name: string;
  deviceId: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: string;
  durationSec: string;
}

const EMPTY_FORM: RuleForm = {
  name: "",
  deviceId: "",
  metric: "cpu_usage",
  operator: ">",
  threshold: "90",
  durationSec: "60",
};

export default function Alerts({ isAdmin }: AlertsProps): React.JSX.Element {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<"active" | "resolved" | "all">("active");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookNote, setWebhookNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, d, a] = await Promise.all([
        api.alertRules(),
        api.devices(),
        api.alerts(filter),
      ]);
      setRules(r.rules);
      setDevices(d.devices);
      setAlerts(a.alerts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load alerts");
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    api
      .alertSettings()
      .then((s) => setWebhookUrl(s.webhookUrl))
      .catch(() => undefined);
  }, []);

  async function createRule(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    const threshold = Number(form.threshold);
    const durationSec = Number(form.durationSec);
    if (!form.name.trim()) return setFormError("Name is required");
    if (!Number.isFinite(threshold)) return setFormError("Threshold must be a number");
    if (!Number.isFinite(durationSec) || durationSec < 0) {
      return setFormError("Duration must be a non-negative number");
    }
    try {
      await api.createAlertRule({
        name: form.name.trim(),
        deviceId: form.deviceId || null,
        metric: form.metric,
        operator: form.operator,
        threshold,
        durationSec,
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to create rule");
    }
  }

  async function toggleRule(rule: AlertRule): Promise<void> {
    try {
      await api.updateAlertRule(rule.id, { enabled: !rule.enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update rule");
    }
  }

  async function deleteRule(rule: AlertRule): Promise<void> {
    try {
      await api.deleteAlertRule(rule.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete rule");
    }
  }

  async function saveWebhook(): Promise<void> {
    try {
      await api.updateAlertSettings(webhookUrl.trim());
      setWebhookNote("saved");
      setTimeout(() => setWebhookNote(null), 2_000);
    } catch (err) {
      setWebhookNote(err instanceof Error ? err.message : "failed to save");
    }
  }

  return (
    <main className="alerts-page">
      {error && <div className="banner">{error}</div>}

      <section className="panel">
        <h2 className="panel-title">Alert rules</h2>
        <form className="rule-form" onSubmit={createRule}>
          <input
            placeholder="Rule name (e.g. High CPU)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rule-name"
          />
          <select value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}>
            <option value="">All devices</option>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
          <select value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as AlertMetric })}>
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value as AlertOperator })}>
            {OPERATORS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <input
            type="number"
            className="rule-num"
            title="Threshold (%)"
            value={form.threshold}
            onChange={(e) => setForm({ ...form, threshold: e.target.value })}
          />
          <input
            type="number"
            className="rule-num"
            title="Duration (seconds)"
            value={form.durationSec}
            onChange={(e) => setForm({ ...form, durationSec: e.target.value })}
          />
          <button type="submit">Add rule</button>
        </form>
        {formError && <p className="error">{formError}</p>}

        {rules.length === 0 ? (
          <p className="dim">
            No rules yet. Add one above — e.g. “Disk almost full”: disk_pct &gt; 90 for 60 s.
          </p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Target</th>
                <th>Condition</th>
                <th>Duration</th>
                <th>Enabled</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td className="hostname">{rule.name}</td>
                  <td className="dim">
                    {rule.deviceId
                      ? (devices.find((d) => d.id === rule.deviceId)?.hostname ?? rule.deviceId)
                      : "All devices"}
                  </td>
                  <td className="mono">
                    {METRICS.find((m) => m.value === rule.metric)?.label ?? rule.metric} {rule.operator}{" "}
                    {rule.threshold}%
                  </td>
                  <td className="dim">{rule.durationSec}s</td>
                  <td>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => void toggleRule(rule)}
                      />
                      <span className="slider" />
                    </label>
                  </td>
                  <td>
                    <button className="ghost danger" onClick={() => void deleteRule(rule)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Alerts</h2>
          <div className="filter-tabs">
            {(["active", "resolved", "all"] as const).map((f) => (
              <button
                key={f}
                className={filter === f ? "filter-tab active" : "filter-tab"}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {alerts.length === 0 ? (
          <p className="dim">No {filter} alerts.</p>
        ) : (
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className={`alert-item ${alert.state}`}>
                <div className="alert-main">
                  <span className={`alert-badge ${alert.state}`}>
                    {alert.state === "active" ? "ACTIVE" : "RESOLVED"}
                  </span>
                  <span className="alert-message">{alert.message}</span>
                </div>
                <div className="alert-meta">
                  <span>
                    rule “{alert.ruleName}” · {formatAgo(alert.lastSeenAt)}
                  </span>
                  <span>
                    {alert.state === "resolved" && alert.resolvedAt
                      ? `resolved ${formatDateTime(alert.resolvedAt)}`
                      : `since ${formatDateTime(alert.createdAt)}`}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section className="panel">
          <h2 className="panel-title">Webhook</h2>
          <p className="dim">
            Receive POSTs on alert transitions:{" "}
            <code>{"{ event: 'alert.fired' | 'alert.resolved', alert }"}</code>
          </p>
          <div className="webhook-row">
            <input
              placeholder="https://example.com/hooks/rmm"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
            <button onClick={() => void saveWebhook()}>Save</button>
            {webhookNote && <span className="dim">{webhookNote}</span>}
          </div>
        </section>
      )}
    </main>
  );
}
