import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AgentUpdate, DeviceUpdateInfo } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo } from "./format.js";

interface UpdatesProps {
  isAdmin: boolean;
}

const UPDATE_STATUS_LABEL: Record<AgentUpdate["status"], string> = {
  pending: "pending",
  downloading: "downloading",
  verifying: "verifying",
  restarting: "restarting",
  completed: "completed",
  failed: "failed",
};

export default function Updates({ isAdmin }: UpdatesProps): React.JSX.Element {
  const [info, setInfo] = useState<DeviceUpdateInfo[]>([]);
  const [history, setHistory] = useState<AgentUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ url: "", sha256: "", deviceIds: "", allDevices: true });
  const [formError, setFormError] = useState<string | null>(null);
  const [formNote, setFormNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [i, u] = await Promise.all([api.updateInfo(), api.updates()]);
      setInfo(i.devices);
      setHistory(u.updates);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load updates");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function dispatch(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setFormNote(null);
    if (!/^https?:\/\//.test(form.url)) return setFormError("URL must start with http(s)://");
    if (!/^[a-fA-F0-9]{64}$/.test(form.sha256)) {
      return setFormError("SHA-256 must be 64 hex characters");
    }
    try {
      const ids = form.allDevices ? null : form.deviceIds.split(/[\s,]+/).filter(Boolean);
      const res = await api.dispatchUpdate({
        url: form.url,
        sha256: form.sha256.toLowerCase(),
        deviceIds: ids,
      });
      setFormNote(`dispatched to ${res.updates.length} device(s)`);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to dispatch update");
    }
  }

  return (
    <main className="updates-page">
      {error && <div className="banner">{error}</div>}

      {isAdmin && (
        <section className="panel">
          <h2 className="panel-title">Deploy agent update</h2>
          <p className="dim">
            Point at a packaged agent bundle (<code>openrmm-agent.js</code>) plus its SHA-256.
            The agent downloads, verifies, replaces itself, and restarts.
            <br />
            Get the hash with:{" "}
            <code>certutil -hashfile openrmm-agent.js SHA256</code> (Windows) or{" "}
            <code>shasum -a 256</code> (macOS).
          </p>
          <form className="update-form" onSubmit={dispatch}>
            <input
              placeholder="https://example.com/openrmm-agent.js"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              className="update-url"
            />
            <input
              placeholder="SHA-256 (64 hex chars)"
              value={form.sha256}
              onChange={(e) => setForm({ ...form, sha256: e.target.value })}
              className="update-sha"
            />
            <div className="job-targets">
              <label className="inline-label">
                <input
                  type="radio"
                  checked={form.allDevices}
                  onChange={() => setForm({ ...form, allDevices: true })}
                />
                All online devices
              </label>
              <label className="inline-label">
                <input
                  type="radio"
                  checked={!form.allDevices}
                  onChange={() => setForm({ ...form, allDevices: false })}
                />
                Device IDs (space/comma separated)
              </label>
              {!form.allDevices && (
                <input
                  placeholder="550e8400-e29b-41d4-a716-446655440000, …"
                  value={form.deviceIds}
                  onChange={(e) => setForm({ ...form, deviceIds: e.target.value })}
                  className="update-url"
                />
              )}
            </div>
            <div className="job-form-row">
              <button type="submit">Deploy</button>
              {formNote && <span className="dim">{formNote}</span>}
            </div>
          </form>
          {formError && <p className="error">{formError}</p>}
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Devices</h2>
        <table className="rules">
          <thead>
            <tr>
              <th>Device</th>
              <th>OS</th>
              <th>Agent</th>
              <th>Pending updates</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {info.map((d) => (
              <tr key={d.deviceId}>
                <td className="hostname">
                  {d.deviceHostname} <span className={`dot ${d.online ? "online" : "offline"}`} />
                </td>
                <td className="mono">
                  {d.os} {d.osVersion}
                </td>
                <td className="mono">v{d.agentVersion}</td>
                <td>
                  {d.pendingUpdates === null ? (
                    <span className="dim">not reported</span>
                  ) : d.pendingUpdates === 0 ? (
                    <span className="online-text">up to date</span>
                  ) : (
                    <span className="pending-count">{d.pendingUpdates} pending</span>
                  )}
                </td>
                <td className="dim">
                  {d.updateCheckedAt ? formatAgo(d.updateCheckedAt) : "—"}
                </td>
              </tr>
            ))}
            {info.length === 0 && (
              <tr>
                <td colSpan={5} className="dim">
                  No devices.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel-title">Agent update history</h2>
        {history.length === 0 ? (
          <p className="dim">No agent updates dispatched yet.</p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>Device</th>
                <th>Version</th>
                <th>Status</th>
                <th>Dispatched</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {history.map((u) => (
                <tr key={u.id}>
                  <td className="hostname">{u.deviceHostname}</td>
                  <td className="mono">
                    {u.fromVersion}
                    {u.toVersion && ` → ${u.toVersion}`}
                  </td>
                  <td>
                    <span className={`job-badge ${u.status}`}>
                      {UPDATE_STATUS_LABEL[u.status]}
                    </span>
                  </td>
                  <td className="dim">{formatAgo(u.createdAt)}</td>
                  <td className="dim" title={u.error ?? undefined}>
                    {u.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
