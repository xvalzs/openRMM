import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Device, FileTransferInfo } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatBytes } from "./format.js";

const STATUS_LABEL: Record<FileTransferInfo["status"], string> = {
  pending: "pending",
  transferring: "transferring",
  done: "done",
  failed: "failed",
};

export default function Files(): React.JSX.Element {
  const [transfers, setTransfers] = useState<FileTransferInfo[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadForm, setUploadForm] = useState({ deviceId: "", destPath: "C:\\Temp" });
  const [file, setFile] = useState<File | null>(null);
  const [downloadForm, setDownloadForm] = useState({ deviceId: "", path: "" });
  const [note, setNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [t, d] = await Promise.all([api.transfers(), api.devices()]);
      setTransfers(t.transfers);
      setDevices(d.devices);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load transfers");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function upload(event: FormEvent): Promise<void> {
    event.preventDefault();
    setNote(null);
    if (!uploadForm.deviceId) return setNote("Pick a device");
    if (!file) return setNote("Pick a file");
    try {
      await api.uploadFile(uploadForm.deviceId, uploadForm.destPath.trim(), file);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNote("upload started");
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "upload failed");
    }
  }

  async function download(event: FormEvent): Promise<void> {
    event.preventDefault();
    setNote(null);
    if (!downloadForm.deviceId || !downloadForm.path.trim()) {
      return setNote("Device and remote path are required");
    }
    try {
      await api.downloadFile(downloadForm.deviceId, downloadForm.path.trim());
      setNote("download started");
      await refresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "download failed");
    }
  }

  const onlineDevices = devices.filter((d) => d.online);

  return (
    <main className="files-page">
      {error && <div className="banner">{error}</div>}

      <section className="panel">
        <h2 className="panel-title">Upload to device</h2>
        <form className="file-form" onSubmit={upload}>
          <div className="job-form-row">
            <select
              value={uploadForm.deviceId}
              onChange={(e) => setUploadForm({ ...uploadForm, deviceId: e.target.value })}
            >
              <option value="">Select device…</option>
              {onlineDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
            <input
              placeholder="Destination path (e.g. C:\Temp or /tmp)"
              value={uploadForm.destPath}
              onChange={(e) => setUploadForm({ ...uploadForm, destPath: e.target.value })}
              className="file-path"
            />
          </div>
          <div className="job-form-row">
            <input
              ref={fileInputRef}
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button type="submit" disabled={!file || !uploadForm.deviceId}>
              Upload
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2 className="panel-title">Download from device</h2>
        <form className="file-form" onSubmit={download}>
          <div className="job-form-row">
            <select
              value={downloadForm.deviceId}
              onChange={(e) => setDownloadForm({ ...downloadForm, deviceId: e.target.value })}
            >
              <option value="">Select device…</option>
              {onlineDevices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                </option>
              ))}
            </select>
            <input
              placeholder="Remote file path"
              value={downloadForm.path}
              onChange={(e) => setDownloadForm({ ...downloadForm, path: e.target.value })}
              className="file-path"
            />
            <button type="submit" disabled={!downloadForm.deviceId || !downloadForm.path.trim()}>
              Download
            </button>
          </div>
        </form>
        {note && <p className="dim">{note}</p>}
      </section>

      <section className="panel">
        <h2 className="panel-title">Transfers</h2>
        {transfers.length === 0 ? (
          <p className="dim">No transfers yet.</p>
        ) : (
          <table className="rules">
            <thead>
              <tr>
                <th>Direction</th>
                <th>Device</th>
                <th>File</th>
                <th>Path</th>
                <th>Progress</th>
                <th>Status</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.direction === "upload" ? "→ device" : "← device"}</td>
                  <td className="hostname">{t.deviceHostname}</td>
                  <td className="mono">{t.name}</td>
                  <td className="dim mono">{t.path}</td>
                  <td className="mono">
                    {t.size > 0
                      ? `${formatBytes(t.transferred)} / ${formatBytes(t.size)}`
                      : t.transferred > 0
                        ? formatBytes(t.transferred)
                        : "—"}
                  </td>
                  <td>
                    <span className={`job-badge ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    {t.error && (
                      <div className="dim" title={t.error}>
                        {t.error}
                      </div>
                    )}
                  </td>
                  <td className="dim">{formatAgo(t.createdAt)}</td>
                  <td>
                    {t.direction === "download" && t.status === "done" && (
                      <a className="ghost file-dl" href={api.downloadUrl(t.id)}>
                        Save
                      </a>
                    )}
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
