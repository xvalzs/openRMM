import type { Device } from "@openrmm/shared";
import { formatAgo, formatBytes, formatDateTime, formatPercent, formatUptime } from "./format.js";

interface DeviceDetailProps {
  device: Device;
  onClose: () => void;
  onOpenShell?: () => void;
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export default function DeviceDetail({ device, onClose, onOpenShell }: DeviceDetailProps): React.JSX.Element {
  const memPct = device.totalMem > 0 ? (device.memUsed / device.totalMem) * 100 : 0;

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <h2>{device.hostname}</h2>
          <div className="detail-status">
            <span className={`dot ${device.online ? "online" : "offline"}`} />
            {device.online ? "online" : "offline"}
            {device.online && <> · up {formatUptime(device.uptime)}</>}
          </div>
        </div>
        <button className="ghost" onClick={onClose} aria-label="Close detail">
          ✕
        </button>
      </div>

      <div className="detail-actions">
        {onOpenShell && (
          <button className="shell-btn" onClick={onOpenShell} disabled={!device.online} title={device.online ? "Open a remote shell" : "Device is offline"}>
            ⌁ Open shell
          </button>
        )}
      </div>

      <section className="detail-section">
        <h3>Resources</h3>
        <div className="resource">
          <div className="resource-head">
            <span>CPU</span>
            <span>{formatPercent(device.cpuUsage)}</span>
          </div>
          <div className="bar">
            <div
              className="bar-fill low"
              style={{ width: `${Math.max(0, Math.min(100, device.cpuUsage))}%` }}
            />
          </div>
        </div>
        <div className="resource">
          <div className="resource-head">
            <span>Memory</span>
            <span>
              {formatBytes(device.memUsed)} / {formatBytes(device.totalMem)}
            </span>
          </div>
          <div className="bar">
            <div className="bar-fill low" style={{ width: `${Math.max(0, Math.min(100, memPct))}%` }} />
          </div>
        </div>
      </section>

      {device.drives.length > 0 && (
        <section className="detail-section">
          <h3>Storage</h3>
          {device.drives.map((drive) => {
            const usedPct = drive.total > 0 ? ((drive.total - drive.free) / drive.total) * 100 : 0;
            return (
              <div className="resource" key={drive.mount}>
                <div className="resource-head">
                  <span>{drive.mount}</span>
                  <span>
                    {formatBytes(drive.total - drive.free)} / {formatBytes(drive.total)}
                  </span>
                </div>
                <div className="bar">
                  <div
                    className={`bar-fill ${usedPct >= 90 ? "high" : usedPct >= 75 ? "mid" : "low"}`}
                    style={{ width: `${Math.max(0, Math.min(100, usedPct))}%` }}
                  />
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="detail-section">
        <h3>System</h3>
        <div className="stat-grid">
          <Stat label="OS" value={`${device.os} ${device.osVersion}`} />
          <Stat label="Architecture" value={`${device.platform} / ${device.arch}`} />
          <Stat label="CPU" value={`${device.cpuModel}`} />
          <Stat label="Cores" value={String(device.cpuCount)} />
          <Stat label="Memory" value={formatBytes(device.totalMem)} />
        </div>
      </section>

      <section className="detail-section">
        <h3>Agent</h3>
        <div className="stat-grid">
          <Stat label="Version" value={device.agentVersion} />
          <Stat label="Last IP" value={device.lastIp || "—"} />
          <Stat label="First seen" value={formatDateTime(device.firstSeen)} />
          <Stat label="Last seen" value={device.online ? "now" : formatAgo(device.lastSeen)} />
        </div>
        <div className="device-id" title={device.id}>
          {device.id}
        </div>
      </section>
    </aside>
  );
}
