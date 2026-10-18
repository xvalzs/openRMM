import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import type { Device, JobResult, JobSummary } from "@openrmm/shared";
import { api } from "./api.js";
import { formatAgo, formatDateTime } from "./format.js";

const STATUS_LABEL: Record<JobResult["status"], string> = {
  pending: "pending",
  running: "running",
  success: "success",
  failed: "failed",
  timeout: "timeout",
  skipped: "skipped",
  cancelled: "cancelled",
};

interface JobForm {
  name: string;
  script: string;
  deviceIds: string[];
  allDevices: boolean;
  timeoutSec: string;
}

const EMPTY_FORM: JobForm = {
  name: "",
  script: "",
  deviceIds: [],
  allDevices: true,
  timeoutSec: "60",
};

export default function Jobs(): React.JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [results, setResults] = useState<JobResult[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<JobForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [j, d] = await Promise.all([api.jobs(), api.devices()]);
      setJobs(j.jobs);
      setDevices(d.devices);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load jobs");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedJobId) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const detail = await api.job(selectedJobId);
        if (!cancelled) setResults(detail.results);
      } catch {
        if (!cancelled) setResults(null);
      }
    };
    void load();
    const timer = setInterval(load, 2_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedJobId]);

  async function createJob(event: FormEvent): Promise<void> {
    event.preventDefault();
    setFormError(null);
    if (!form.name.trim()) return setFormError("Name is required");
    if (!form.script.trim()) return setFormError("Script is required");
    const timeoutSec = Number(form.timeoutSec);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 5) {
      return setFormError("Timeout must be at least 5 seconds");
    }
    try {
      await api.createJob({
        name: form.name.trim(),
        script: form.script,
        deviceIds: form.allDevices ? null : form.deviceIds,
        timeoutSec,
      });
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "failed to create job");
    }
  }

  async function cancelJob(id: string): Promise<void> {
    try {
      await api.cancelJob(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to cancel job");
    }
  }

  async function deleteJob(id: string): Promise<void> {
    try {
      await api.deleteJob(id);
      if (selectedJobId === id) {
        setSelectedJobId(null);
        setResults(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to delete job");
    }
  }

  function toggleExpand(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const onlineDevices = devices.filter((d) => d.online);

  return (
    <main className="jobs-page">
      {error && <div className="banner">{error}</div>}

      <section className="panel">
        <h2 className="panel-title">New job</h2>
        <form className="job-form" onSubmit={createJob}>
          <div className="job-form-row">
            <input
              placeholder="Job name (e.g. Clear temp files)"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="job-name"
            />
            <label className="inline-label">
              Timeout (s)
              <input
                type="number"
                className="rule-num"
                value={form.timeoutSec}
                onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
              />
            </label>
            <button type="submit">Run job</button>
          </div>
          <textarea
            placeholder={"# Script to run on each device\n# Windows: PowerShell · macOS/Linux: bash"}
            value={form.script}
            onChange={(e) => setForm({ ...form, script: e.target.value })}
            rows={6}
            className="job-script"
          />
          <div className="job-targets">
            <label className="inline-label">
              <input
                type="radio"
                checked={form.allDevices}
                onChange={() => setForm({ ...form, allDevices: true })}
              />
              All online devices ({onlineDevices.length})
            </label>
            <label className="inline-label">
              <input
                type="radio"
                checked={!form.allDevices}
                onChange={() => setForm({ ...form, allDevices: false })}
              />
              Selected devices
            </label>
            {!form.allDevices && (
              <div className="job-device-checks">
                {devices.map((d) => (
                  <label key={d.id} className="inline-label">
                    <input
                      type="checkbox"
                      checked={form.deviceIds.includes(d.id)}
                      onChange={(e) => {
                        const ids = e.target.checked
                          ? [...form.deviceIds, d.id]
                          : form.deviceIds.filter((x) => x !== d.id);
                        setForm({ ...form, deviceIds: ids });
                      }}
                    />
                    {d.hostname}
                    <span className={`dot ${d.online ? "online" : "offline"}`} />
                  </label>
                ))}
              </div>
            )}
          </div>
        </form>
        {formError && <p className="error">{formError}</p>}
      </section>

      <section className="panel">
        <h2 className="panel-title">Jobs</h2>
        {jobs.length === 0 ? (
          <p className="dim">No jobs yet. Create one above.</p>
        ) : (
          <table className="rules jobs-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Results</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <Fragment key={job.id}>
                  <tr
                    className={selectedJobId === job.id ? "selected" : undefined}
                    onClick={() => setSelectedJobId(selectedJobId === job.id ? null : job.id)}
                  >
                    <td className="hostname">
                      {job.name}
                      <div className="sub">by {job.createdBy}</div>
                    </td>
                    <td>
                      <span className={`job-badge ${job.status}`}>{job.status}</span>
                    </td>
                    <td className="mono">
                      {job.success} ok · {job.failed} failed · {job.skipped} skipped ·{" "}
                      {job.pending + job.running} left
                    </td>
                    <td className="dim">{formatAgo(job.createdAt)}</td>
                    <td className="job-actions">
                      {job.status === "running" && (
                        <button className="ghost" onClick={() => void cancelJob(job.id)}>
                          Cancel
                        </button>
                      )}
                      <button className="ghost danger" onClick={() => void deleteJob(job.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                  {selectedJobId === job.id && (
                    <tr className="job-detail-row">
                      <td colSpan={5}>
                        {results === null ? (
                          <p className="dim">Loading results…</p>
                        ) : (
                          <div className="job-results">
                            {results.map((r) => (
                              <div key={r.deviceId} className="job-result">
                                <div className="job-result-head">
                                  <span className="hostname">{r.deviceHostname}</span>
                                  <span className={`job-badge ${r.status}`}>
                                    {STATUS_LABEL[r.status]}
                                    {r.exitCode !== null && ` (${r.exitCode})`}
                                  </span>
                                  {r.finishedAt && (
                                    <span className="dim">
                                      finished {formatDateTime(r.finishedAt)}
                                    </span>
                                  )}
                                  {(r.stdout || r.stderr) && (
                                    <button
                                      className="ghost"
                                      onClick={() => toggleExpand(r.deviceId)}
                                    >
                                      {expanded.has(r.deviceId) ? "Hide output" : "Show output"}
                                    </button>
                                  )}
                                </div>
                                {expanded.has(r.deviceId) && (
                                  <div className="job-output">
                                    {r.stdout && (
                                      <pre className="job-stdout">{r.stdout}</pre>
                                    )}
                                    {r.stderr && (
                                      <pre className="job-stderr">{r.stderr}</pre>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
