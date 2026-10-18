import { useCallback, useEffect, useState } from "react";
import type { AuditEntry } from "@openrmm/shared";
import { api } from "./api.js";
import { formatDateTime } from "./format.js";

export default function Audit(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.audit(300);
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load audit log");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <main className="audit-page">
      {error && <div className="banner">{error}</div>}
      <section className="panel">
        <h2 className="panel-title">Audit log</h2>
        {entries.length === 0 ? (
          <p className="dim">No entries yet. Actions will appear here as they happen.</p>
        ) : (
          <table className="rules audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Target</th>
                <th>IP</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="dim">{formatDateTime(e.ts)}</td>
                  <td className="hostname">{e.username}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono">{e.target ?? "—"}</td>
                  <td className="dim">{e.ip ?? "—"}</td>
                  <td className="dim mono">{e.meta ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
