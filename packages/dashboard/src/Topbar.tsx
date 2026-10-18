import type { SessionInfo } from "@openrmm/shared";

export type View = "devices" | "alerts";

interface TopbarProps {
  session: SessionInfo;
  view: View;
  onNavigate: (view: View) => void;
  onLogout: () => void;
}

export default function Topbar({ session, view, onNavigate, onLogout }: TopbarProps): React.JSX.Element {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">OpenRMM</span>
      </div>
      <nav className="nav">
        <button
          className={view === "devices" ? "nav-tab active" : "nav-tab"}
          onClick={() => onNavigate("devices")}
        >
          Devices
        </button>
        <button
          className={view === "alerts" ? "nav-tab active" : "nav-tab"}
          onClick={() => onNavigate("alerts")}
        >
          Alerts
        </button>
      </nav>
      <div className="topbar-user">
        <span>{session.username}</span>
        <button className="ghost" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}
