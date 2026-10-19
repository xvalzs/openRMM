import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "@openrmm/shared";
import { api } from "./api.js";
import Login from "./Login.js";
import Devices from "./Devices.js";
import Alerts from "./Alerts.js";
import Jobs from "./Jobs.js";
import Updates from "./Updates.js";
import Files from "./Files.js";
import Keys from "./Keys.js";
import Users from "./Users.js";
import Audit from "./Audit.js";
import Topbar, { type View } from "./Topbar.js";

export default function App(): React.JSX.Element {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>("devices");

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setSession(null);
    }
  }, []);

  if (checking) {
    return (
      <div className="boot">
        <span className="spinner" aria-hidden="true" />
        <span>Loading OpenRMM…</span>
      </div>
    );
  }

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  const isAdmin = session.role === "admin";
  const content =
    view === "devices" ? (
      <Devices isAdmin={isAdmin} />
    ) : view === "alerts" ? (
      <Alerts isAdmin={isAdmin} />
    ) : view === "jobs" ? (
      <Jobs />
    ) : view === "updates" ? (
      <Updates isAdmin={isAdmin} />
    ) : view === "files" && isAdmin ? (
      <Files />
    ) : view === "keys" ? (
      <Keys />
    ) : view === "users" && isAdmin ? (
      <Users session={session} />
    ) : view === "audit" && isAdmin ? (
      <Audit />
    ) : (
      <Devices isAdmin={isAdmin} />
    );

  return (
    <div className="shell">
      <Topbar session={session} view={view} onNavigate={setView} onLogout={handleLogout} />
      {content}
    </div>
  );
}
