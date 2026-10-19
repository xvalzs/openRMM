import { useEffect, useState } from "react";
import type { Device, DeviceListResponse } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatBytes, formatPercent, formatUptime } from "./format.js";
import DeviceDetail from "./DeviceDetail.js";
import ShellPanel from "./ShellPanel.js";

const POLL_MS = 5_000;

interface DevicesProps {
  isAdmin: boolean;
}

function UsageBar({ value, warnAt = 80 }: { value: number; warnAt?: number }): React.JSX.Element {
  const level = value >= warnAt ? "high" : value >= warnAt * 0.75 ? "mid" : "low";
  return (
    <div className="bar">
      <div
        className={`bar-fill ${level}`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function primaryDrive(device: Device): { mount: string; usedPct: number } | null {
  const drive = device.drives[0];
  if (!drive || drive.total <= 0) return null;
  return {
    mount: drive.mount,
    usedPct: ((drive.total - drive.free) / drive.total) * 100,
  };
}

export default function Devices({ isAdmin }: DevicesProps): React.JSX.Element {
  const [data, setData] = useState<DeviceListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shellDevice, setShellDevice] = useState<Device | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = async (): Promise<void> => {
      try {
        const next = await api.devices();
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed to load devices");
      }
    };

    void refresh();
    timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  const devices = data?.devices ?? [];
  const selected =
    devices.find((d) => d.id === selectedId) ?? devices[0] ?? null;

  return (
    <div className="device-view">
      {error && <div className="banner">{error}</div>}

      <div className="summary-line">
        <span className="pill">
          <span className="dot online" /> {data?.summary.online ?? 0} online
        </span>
        <span className="pill">{data?.summary.total ?? 0} total</span>
      </div>

      <main className="content">
        <section className="device-list">
          {devices.length === 0 ? (
            <div className="empty">
              <h2>No devices yet</h2>
              <p>
                Install the agent on an endpoint and it will appear here:
              </p>
              <pre>
                openrmm-agent install --server https://your-server --key YOUR_KEY
                {"\n"}
                openrmm-agent run
              </pre>
            </div>
          ) : (
            <table className="devices">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Device</th>
                  <th>OS</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Disk</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => {
                  const drive = primaryDrive(device);
                  const memPct = device.totalMem > 0 ? (device.memUsed / device.totalMem) * 100 : 0;
                  return (
                    <tr
                      key={device.id}
                      className={selected?.id === device.id ? "selected" : undefined}
                      onClick={() => setSelectedId(device.id)}
                    >
                      <td>
                        <span className={`dot ${device.online ? "online" : "offline"}`} />
                      </td>
                      <td className="device-name">
                        <div className="hostname">{device.hostname}</div>
                        <div className="sub">{device.lastIp || "—"}</div>
                      </td>
                      <td className="os">
                        {device.os} {device.osVersion}
                      </td>
                      <td className="metric">
                        <UsageBar value={device.cpuUsage} />
                        <span className="metric-value">{formatPercent(device.cpuUsage)}</span>
                      </td>
                      <td className="metric">
                        <UsageBar value={memPct} />
                        <span className="metric-value">
                          {formatBytes(device.memUsed)} / {formatBytes(device.totalMem)}
                        </span>
                      </td>
                      <td className="metric">
                        {drive ? (
                          <>
                            <UsageBar value={drive.usedPct} />
                            <span className="metric-value">{formatPercent(drive.usedPct)}</span>
                          </>
                        ) : (
                          <span className="metric-value">—</span>
                        )}
                      </td>
                      <td className="last-seen">
                        {device.online ? (
                          <span className="online-text">online · {formatUptime(device.uptime)} up</span>
                        ) : (
                          formatAgo(device.lastSeen)
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        {selected && (
          <DeviceDetail
            device={selected}
            onClose={() => setSelectedId(null)}
            onOpenShell={isAdmin ? () => setShellDevice(selected) : undefined}
            isAdmin={isAdmin}
          />
        )}
      </main>

      {shellDevice && (
        <ShellPanel
          deviceId={shellDevice.id}
          deviceName={shellDevice.hostname}
          onClose={() => setShellDevice(null)}
        />
      )}
    </div>
  );
}
