import type { SessionInfo } from "@openrmm/shared";

export type View = "devices" | "alerts" | "jobs" | "updates" | "files" | "installers" | "keys" | "users" | "audit";

interface TopbarProps {
  session: SessionInfo;
  view: View;
  onNavigate: (view: View) => void;
  onLogout: () => void;
}

export default function Topbar({ session, view, onNavigate, onLogout }: TopbarProps): React.JSX.Element {
  const tabs: { id: View; label: string; adminOnly?: boolean }[] = [
    { id: "devices", label: "Devices" },
    { id: "alerts", label: "Alerts" },
    { id: "jobs", label: "Jobs" },
    { id: "updates", label: "Updates" },
    { id: "files", label: "Files", adminOnly: true },
    { id: "installers", label: "Installers", adminOnly: true },
    { id: "keys", label: "API Keys" },
    { id: "users", label: "Users", adminOnly: true },
    { id: "audit", label: "Audit", adminOnly: true },
  ];
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">OpenRMM</span>
      </div>
      <nav className="nav">
        {tabs
          .filter((t) => !t.adminOnly || session.role === "admin")
          .map((t) => (
            <button
              key={t.id}
              className={view === t.id ? "nav-tab active" : "nav-tab"}
              onClick={() => onNavigate(t.id)}
            >
              {t.label}
            </button>
          ))}
      </nav>
      <div className="topbar-user">
        <span className="role-pill">{session.role}</span>
        <span>{session.username}</span>
        <button className="ghost" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
