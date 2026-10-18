import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SessionInfo, UserInfo, UserRole } from "@openrmm/shared";
import { api } from "./api.js";
import { formatDateTime } from "./format.js";

interface UsersProps {
  session: SessionInfo;
}

export default function Users({ session }: UsersProps): React.JSX.Element {
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "operator" as UserRole });
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.users();
      setUsers(res.users);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load users");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createUser(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    try {
      await api.createUser(form);
      setForm({ username: "", password: "", role: "operator" });
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to create user");
    }
  }

  async function changeRole(user: UserInfo, role: UserRole): Promise<void> {
    try {
      await api.updateUser(user.id, { role });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to update user");
    }
  }

  async function deleteUser(user: UserInfo): Promise<void> {
    try {
      await api.deleteUser(user.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete user");
    }
  }

  return (
    <main className="users-page">
      {error && <div className="banner">{error}</div>}

      <section className="panel">
        <h2 className="panel-title">Users</h2>
        <table className="rules">
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td className="hostname">
                  {user.username}
                  {user.id === session.userId && <span className="dim"> (you)</span>}
                </td>
                <td>
                  <select
                    value={user.role}
                    disabled={user.id === session.userId}
                    onChange={(e) => void changeRole(user, e.target.value as UserRole)}
                  >
                    <option value="admin">admin</option>
                    <option value="operator">operator</option>
                  </select>
                </td>
                <td className="dim">{formatDateTime(user.createdAt)}</td>
                <td>
                  <button
                    className="ghost danger"
                    disabled={user.id === session.userId}
                    onClick={() => void deleteUser(user)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2 className="panel-title">Add user</h2>
        <form className="rule-form" onSubmit={createUser}>
          <input
            placeholder="Username"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            className="rule-name"
          />
          <input
            type="password"
            placeholder="Password (min 8 chars)"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="rule-name"
          />
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
          >
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit">Add user</button>
        </form>
        {formError && <p className="error">{formError}</p>}
        <p className="dim">
          <strong>admin</strong> — full access, including shells and user management.
          <br />
          <strong>operator</strong> — monitoring, alerts, and jobs. No remote shells, user
          management, or webhook settings.
        </p>
      </section>
    </main>
  );
}
