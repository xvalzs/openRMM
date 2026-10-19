import { useEffect, useState } from "react";
import type { Device, ProcessInfo } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatBytes, formatDateTime, formatPercent, formatUptime } from "./format.js";

interface DeviceDetailProps {
  device: Device;
  onClose: () => void;
  onOpenShell?: () => void;
  onOpenScreen?: () => void;
  isAdmin?: boolean;
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

export default function DeviceDetail({ device, onClose, onOpenShell, onOpenScreen, isAdmin }: DeviceDetailProps): React.JSX.Element {
  const memPct = device.totalMem > 0 ? (device.memUsed / device.totalMem) * 100 : 0;
  const [processes, setProcesses] = useState<ProcessInfo[] | null>(null);
  const [procTs, setProcTs] = useState<number | null>(null);
  const [procError, setProcError] = useState<string | null>(null);
  const [procBusy, setProcBusy] = useState(false);

  async function refreshProcesses(): Promise<void> {
    if (!device.online) return;
    setProcBusy(true);
    setProcError(null);
    try {
      if (procTs === null) {
        await api.refreshProcesses(device.id);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        await api.refreshProcesses(device.id);
        await new Promise((r) => setTimeout(r, 1200));
      }
      const res = await api.processes(device.id);
      setProcesses(res.processes);
      setProcTs(res.ts);
    } catch (err) {
      setProcError(err instanceof Error ? err.message : "failed to load processes");
    } finally {
      setProcBusy(false);
    }
  }

  async function killProcess(pid: number): Promise<void> {
    try {
      await api.killProcess(device.id, pid);
      await new Promise((r) => setTimeout(r, 800));
      await api.refreshProcesses(device.id);
      await new Promise((r) => setTimeout(r, 1200));
      const res = await api.processes(device.id);
      setProcesses(res.processes);
      setProcTs(res.ts);
    } catch (err) {
      setProcError(err instanceof Error ? err.message : "failed to kill process");
    }
  }

  useEffect(() => {
    if (isAdmin && device.online) void refreshProcesses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

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
        {onOpenScreen && (
          <button className="screen-btn" onClick={onOpenScreen} disabled={!device.online} title={device.online ? "View and control the screen" : "Device is offline"}>
            ▣ View screen
          </button>
        )}
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

      {isAdmin && device.online && (
        <section className="detail-section">
          <div className="processes-head">
            <h3>Processes</h3>
            <button className="ghost" onClick={() => void refreshProcesses()} disabled={procBusy}>
              {procBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {procError && <p className="error">{procError}</p>}
          {processes === null ? (
            <p className="dim">{procBusy ? "Loading…" : "Click Refresh to list processes."}</p>
          ) : (
            <div className="process-list">
              {[...processes]
                .sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0))
                .slice(0, 25)
                .map((p) => (
                  <div key={p.pid} className="process-row">
                    <span className="process-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="process-meta">
                      pid {p.pid}
                      {p.memBytes !== null && <> · {formatBytes(p.memBytes)}</>}
                    </span>
                    <button className="ghost danger" onClick={() => void killProcess(p.pid)}>
                      Kill
                    </button>
                  </div>
                ))}
              {processes.length === 0 && <p className="dim">No processes reported.</p>}
            </div>
          )}
        </section>
      )}
    </aside>
  );
}
