import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ApiKeyInfo } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatDateTime } from "./format.js";

export default function Keys(): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ApiKeyInfo | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.apiKeys();
      setKeys(res.keys);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load keys");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    if (!name.trim()) return setFormError("Name is required");
    try {
      const key = await api.createApiKey(name.trim());
      setCreated(key);
      setName("");
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to create key");
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api.deleteApiKey(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete key");
    }
  }

  async function copyToken(): Promise<void> {
    if (!created?.token) return;
    try {
      await navigator.clipboard.writeText(created.token);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <main className="keys-page">
      {error && <div className="banner">{error}</div>}

      {created && (
        <section className="panel key-created">
          <h2 className="panel-title">Key created — copy it now</h2>
          <p className="dim">
            The token is shown only once. It grants the same permissions as your account.
          </p>
          <div className="key-token-row">
            <code className="key-token">{created.token}</code>
            <button onClick={() => void copyToken()}>Copy</button>
            <button className="ghost" onClick={() => setCreated(null)}>
              I saved it
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">API keys</h2>
        <p className="dim">
          Use a key with the <code>Authorization: Bearer &lt;token&gt;</code> header to call
          the REST API from scripts. Keys inherit your role.
        </p>
        <form className="rule-form" onSubmit={create}>
          <input
            placeholder="Key name (e.g. nightly backup script)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rule-name"
          />
          <button type="submit">Create key</button>
        </form>
        {formError && <p className="error">{formError}</p>}

        {keys.length === 0 ? (
          <p className="dim">No keys yet.</p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>Name</th>
                <th>Created</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="hostname">{k.name}</td>
                  <td className="dim">{formatDateTime(k.createdAt)}</td>
                  <td className="dim">
                    {k.lastUsedAt ? `${formatAgo(k.lastUsedAt)}` : "never"}
                  </td>
                  <td>
                    <button className="ghost danger" onClick={() => void remove(k.id)}>
                      Revoke
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
