import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { InstallerInfo, InstallerTarget } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatBytes } from "./format.js";

export default function Installers(): React.JSX.Element {
  const [installers, setInstallers] = useState<InstallerInfo[]>([]);
  const [defaults, setDefaults] = useState<{ serverUrl: string; installKey: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "OpenRMM-Agent",
    target: "windows-x64" as InstallerTarget,
    serverUrl: "",
    installKey: "",
    autoService: false,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.installers();
      setInstallers(res.installers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load installers");
    }
  }, []);

  useEffect(() => {
    void refresh();
    api
      .installerDefaults()
      .then((d) => {
        setDefaults(d);
        setForm((f) => ({
          ...f,
          serverUrl: f.serverUrl || d.serverUrl,
          installKey: f.installKey || d.installKey,
        }));
      })
      .catch(() => undefined);
  }, [refresh]);

  async function build(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    setNote(null);
    setBusy(true);
    try {
      const installer = await api.buildInstaller({
        name: form.name.trim(),
        target: form.target,
        serverUrl: form.serverUrl.trim() || undefined,
        installKey: form.installKey.trim() || undefined,
        autoService: form.autoService,
      });
      setNote(`Built ${installer.filename} (${formatBytes(installer.size)})`);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "build failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.deleteInstaller(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete installer");
    }
  }

  return (
    <main className="installers-page">
      {error && <div className="banner">{error}</div>}

      <section className="panel">
        <h2 className="panel-title">Build installer</h2>
        <p className="dim">
          Generates a pre-configured agent that connects to this server automatically —
          no server URL or key to type on the endpoint.
          <br />
          <strong>Windows:</strong> a single self-contained <code>.exe</code>. The
          configuration lives <em>inside</em> the binary, so you can rename the file to
          anything without breaking it — and a code-signing certificate, if configured on
          the server (<code>RMM_SIGNING_PFX</code>), stays valid across renames
          (Authenticode hashes content, not names).
          <br />
          <strong>Heads-up:</strong> without a code-signing certificate, Windows
          SmartScreen / Smart App Control will warn about — or block — the unsigned exe
          on user machines. Until you sign it, the <code>.zip</code> build (or sending
          the exe through a trusted channel like your RMM itself) avoids the warnings.
          <br />
          <strong>macOS / Linux:</strong> a zip with the agent and launcher.
        </p>
        <form className="installer-form" onSubmit={build}>
          <div className="job-form-row">
            <input
              placeholder="Installer name (becomes the filename)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="rule-name"
            />
            <select
              value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value as InstallerTarget })}
            >
              <option value="windows-x64">Windows x64 (.exe)</option>
              <option value="windows-arm64">Windows ARM64 (.exe)</option>
              <option value="windows-zip">Windows (.zip — no exe warnings)</option>
              <option value="posix">macOS / Linux (.zip)</option>
            </select>
            <label className="inline-label">
              <input
                type="checkbox"
                checked={form.autoService}
                onChange={(e) => setForm({ ...form, autoService: e.target.checked })}
              />
              Auto-install as service (needs admin on first run)
            </label>
          </div>
          <div className="job-form-row">
            <input
              placeholder="Server URL agents connect to"
              value={form.serverUrl}
              onChange={(e) => setForm({ ...form, serverUrl: e.target.value })}
              className="file-path"
              title={defaults?.serverUrl ?? undefined}
            />
            <input
              placeholder="Install key"
              type="password"
              value={form.installKey}
              onChange={(e) => setForm({ ...form, installKey: e.target.value })}
              className="file-path"
            />
            <button type="submit" disabled={busy}>
              {busy ? "Building…" : "Build"}
            </button>
          </div>
        </form>
        {formError && <p className="error">{formError}</p>}
        {note && <p className="dim">{note}</p>}
      </section>

      <section className="panel">
        <h2 className="panel-title">Built installers</h2>
        {installers.length === 0 ? (
          <p className="dim">No installers yet. Build one above and send it to your users.</p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>File</th>
                <th>Target</th>
                <th>Size</th>
                <th>SHA-256</th>
                <th>Deployment</th>
                <th>Built</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {installers.map((i) => (
                <tr key={i.id}>
                  <td className="hostname">{i.filename}</td>
                  <td className="mono">{i.target}</td>
                  <td className="mono">{formatBytes(i.size)}</td>
                  <td className="dim mono" title={i.sha256}>
                    {i.sha256.slice(0, 16)}…
                  </td>
                  <td className="dim mono" title={i.deploymentId}>
                    {i.deploymentId.slice(0, 8)}
                  </td>
                  <td className="dim">
                    {formatAgo(i.createdAt)} · {i.createdBy}
                  </td>
                  <td className="job-actions">
                    <a className="ghost file-dl" href={api.installerDownloadUrl(i.id)}>
                      Download
                    </a>
                    <button className="ghost danger" onClick={() => void remove(i.id)}>
                      Delete
                    </button>
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
