/**
 * SQLite storage backed by the Node.js built-in `node:sqlite` module.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentUpdate,
  Alert,
  AlertRule,
  AlertRuleInput,
  ApiKeyInfo,
  AuditEntry,
  Device,
  DriveInfo,
  InstallerInfo,
  JobDetail,
  JobResult,
  JobSummary,
  MachineInfo,
  Metrics,
  UpdateStatus,
  UserInfo,
  UserRole,
} from "@openrmm/shared";
import { hashPassword, randomHex, safeEqualHex, sha256Hex } from "./crypto.js";

export interface DeviceRow {
  id: string;
  token_hash: string;
  hostname: string;
  os: string;
  os_version: string;
  platform: string;
  arch: string;
  cpu_model: string;
  cpu_count: number;
  total_mem: number;
  drives_json: string;
  agent_version: string;
  last_ip: string;
  cpu_usage: number;
  mem_used: number;
  uptime: number;
  online: number;
  first_seen: number;
  last_seen: number;
  deployment_id: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        hostname TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        os_version TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        arch TEXT NOT NULL DEFAULT '',
        cpu_model TEXT NOT NULL DEFAULT '',
        cpu_count INTEGER NOT NULL DEFAULT 0,
        total_mem INTEGER NOT NULL DEFAULT 0,
        drives_json TEXT NOT NULL DEFAULT '[]',
        agent_version TEXT NOT NULL DEFAULT '',
        last_ip TEXT NOT NULL DEFAULT '',
        cpu_usage REAL NOT NULL DEFAULT 0,
        mem_used INTEGER NOT NULL DEFAULT 0,
        uptime REAL NOT NULL DEFAULT 0,
        online INTEGER NOT NULL DEFAULT 0,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(online);
      CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alert_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        device_id TEXT,
        metric TEXT NOT NULL,
        operator TEXT NOT NULL,
        threshold REAL NOT NULL,
        duration_sec INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        rule_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        value REAL NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        resolved_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_state ON alerts(state);
      CREATE INDEX IF NOT EXISTS idx_alerts_rule_device ON alerts(rule_id, device_id, state);

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        script TEXT NOT NULL,
        timeout_sec INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS job_results (
        job_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT NOT NULL DEFAULT '',
        stderr TEXT NOT NULL DEFAULT '',
        started_at INTEGER,
        finished_at INTEGER,
        PRIMARY KEY (job_id, device_id)
      );

      CREATE INDEX IF NOT EXISTS idx_job_results_job ON job_results(job_id);

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS agent_updates (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        url TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        from_version TEXT NOT NULL,
        to_version TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_agent_updates_device ON agent_updates(device_id, created_at);

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        user_id INTEGER,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        ip TEXT,
        meta TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

      CREATE TABLE IF NOT EXISTS installers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filename TEXT NOT NULL,
        target TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL
      );
    `);

    // users.role was added after the initial schema; backfill on upgrade.
    const userCols = this.db.prepare("PRAGMA table_info(users)").all() as {
      name: string;
    }[];
    if (!userCols.some((c) => c.name === "role")) {
      this.db.exec(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'",
      );
    }

    // devices gained OS update info after the initial schema.
    const deviceCols = this.db.prepare("PRAGMA table_info(devices)").all() as {
      name: string;
    }[];
    if (!deviceCols.some((c) => c.name === "pending_updates")) {
      this.db.exec("ALTER TABLE devices ADD COLUMN pending_updates INTEGER");
    }
    if (!deviceCols.some((c) => c.name === "update_checked_at")) {
      this.db.exec("ALTER TABLE devices ADD COLUMN update_checked_at INTEGER");
    }
    if (!deviceCols.some((c) => c.name === "deployment_id")) {
      this.db.exec("ALTER TABLE devices ADD COLUMN deployment_id TEXT");
    }
  }

  // ---- settings -------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Returns the install key, generating and persisting one on first use. */
  getOrCreateInstallKey(generate: boolean): string | null {
    let key = this.getSetting("install_key");
    if (!key && generate) {
      key = randomHex(32);
      this.setSetting("install_key", key);
    }
    return key;
  }

  verifyInstallKey(candidate: string): boolean {
    const stored = this.getSetting("install_key");
    if (!stored) return false;
    return safeEqualHex(stored, candidate) || safeEqualHex(stored, candidate.trim());
  }

  // ---- users ----------------------------------------------------------

  ensureAdminUser(username: string, password: string): boolean {
    const existing = this.db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username) as { id: number } | undefined;
    if (existing) return false;
    this.db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)",
      )
      .run(username, hashPassword(password), Date.now());
    return true;
  }

  findUserByUsername(username: string): {
    id: number;
    password_hash: string;
    role: string;
  } | null {
    const row = this.db
      .prepare("SELECT id, password_hash, role FROM users WHERE username = ?")
      .get(username) as
      | { id: number; password_hash: string; role: string }
      | undefined;
    return row ?? null;
  }

  findUserById(id: number): { id: number; username: string; role: string } | null {
    const row = this.db
      .prepare("SELECT id, username, role FROM users WHERE id = ?")
      .get(id) as { id: number; username: string; role: string } | undefined;
    return row ?? null;
  }

  listUsers(): UserInfo[] {
    const rows = this.db
      .prepare("SELECT id, username, role, created_at FROM users ORDER BY id ASC")
      .all() as unknown as {
      id: number;
      username: string;
      role: string;
      created_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role as UserRole,
      createdAt: r.created_at,
    }));
  }

  createUser(username: string, password: string, role: UserRole): UserInfo {
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(username, hashPassword(password), role, createdAt);
    return {
      id: Number(res.lastInsertRowid),
      username,
      role,
      createdAt,
    };
  }

  updateUser(
    id: number,
    patch: { password?: string; role?: UserRole },
  ): boolean {
    const existing = this.findUserById(id);
    if (!existing) return false;
    if (patch.password) {
      this.db
        .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
        .run(hashPassword(patch.password), id);
    }
    if (patch.role) {
      this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(patch.role, id);
    }
    return true;
  }

  deleteUser(id: number): boolean {
    const res = this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return res.changes > 0;
  }

  countAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
      .get() as { n: number };
    return row.n;
  }

  // ---- devices --------------------------------------------------------

  /** Upsert a device and rotate its token. Returns the fresh token. */
  registerDevice(
    clientId: string,
    machine: MachineInfo,
    token: string,
    ip: string,
    firstSeen: number,
    deploymentId?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO devices (
           id, token_hash, hostname, os, os_version, platform, arch,
           cpu_model, cpu_count, total_mem, drives_json, agent_version,
           last_ip, deployment_id, first_seen, last_seen
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           token_hash = excluded.token_hash,
           hostname = excluded.hostname,
           os = excluded.os,
           os_version = excluded.os_version,
           platform = excluded.platform,
           arch = excluded.arch,
           cpu_model = excluded.cpu_model,
           cpu_count = excluded.cpu_count,
           total_mem = excluded.total_mem,
           drives_json = excluded.drives_json,
           agent_version = excluded.agent_version,
           last_ip = excluded.last_ip,
           deployment_id = COALESCE(excluded.deployment_id, devices.deployment_id),
           last_seen = excluded.last_seen`,
      )
      .run(
        clientId,
        token,
        machine.hostname,
        machine.os,
        machine.osVersion,
        machine.platform,
        machine.arch,
        machine.cpuModel,
        machine.cpuCount,
        machine.totalMem,
        JSON.stringify(machine.drives),
        machine.agentVersion,
        ip,
        deploymentId ?? null,
        firstSeen,
        Date.now(),
      );
  }

  verifyDeviceToken(deviceId: string, tokenHash: string): boolean {
    const row = this.db
      .prepare("SELECT token_hash FROM devices WHERE id = ?")
      .get(deviceId) as { token_hash: string } | undefined;
    if (!row) return false;
    return safeEqualHex(row.token_hash, tokenHash);
  }

  applyHeartbeat(deviceId: string, metrics: Metrics, online: boolean): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE devices SET
           cpu_usage = ?, mem_used = ?, uptime = ?,
           drives_json = ?, online = ?, last_seen = ?
         WHERE id = ?`,
      )
      .run(
        metrics.cpuUsage,
        metrics.memUsed,
        metrics.uptime,
        JSON.stringify(metrics.drives),
        online ? 1 : 0,
        now,
        deviceId,
      );
  }

  setDeviceOnline(deviceId: string, online: boolean): void {
    this.db
      .prepare("UPDATE devices SET online = ?, last_seen = ? WHERE id = ?")
      .run(online ? 1 : 0, Date.now(), deviceId);
  }

  /** Flip any device without a recent heartbeat to offline. */
  sweepOffline(offlineAfterMs: number): void {
    const cutoff = Date.now() - offlineAfterMs;
    this.db
      .prepare("UPDATE devices SET online = 0 WHERE online = 1 AND last_seen < ?")
      .run(cutoff);
  }

  getDevice(deviceId: string): Device | null {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE id = ?")
      .get(deviceId) as DeviceRow | undefined;
    return row ? rowToDevice(row) : null;
  }

  listDevices(): Device[] {
    const rows = this.db
      .prepare("SELECT * FROM devices ORDER BY online DESC, hostname ASC")
      .all() as unknown as DeviceRow[];
    return rows.map(rowToDevice);
  }

  // ---- alert rules -------------------------------------------------------

  createAlertRule(input: AlertRuleInput): AlertRule {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO alert_rules (id, name, device_id, metric, operator, threshold, duration_sec, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.deviceId ?? null,
        input.metric,
        input.operator,
        input.threshold,
        Math.max(0, Math.round(input.durationSec)),
        input.enabled === false ? 0 : 1,
        Date.now(),
      );
    return this.getAlertRule(id)!;
  }

  getAlertRule(id: string): AlertRule | null {
    const row = this.db
      .prepare("SELECT * FROM alert_rules WHERE id = ?")
      .get(id) as AlertRuleRow | undefined;
    return row ? rowToRule(row) : null;
  }

  listAlertRules(): AlertRule[] {
    const rows = this.db
      .prepare("SELECT * FROM alert_rules ORDER BY created_at ASC")
      .all() as unknown as AlertRuleRow[];
    return rows.map(rowToRule);
  }

  updateAlertRule(id: string, patch: Partial<AlertRuleInput>): AlertRule | null {
    const existing = this.getAlertRule(id);
    if (!existing) return null;
    const next: AlertRuleInput = {
      name: patch.name ?? existing.name,
      deviceId: patch.deviceId !== undefined ? patch.deviceId : existing.deviceId,
      metric: patch.metric ?? existing.metric,
      operator: patch.operator ?? existing.operator,
      threshold: patch.threshold ?? existing.threshold,
      durationSec:
        patch.durationSec !== undefined ? patch.durationSec : existing.durationSec,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
    };
    this.db
      .prepare(
        `UPDATE alert_rules SET name = ?, device_id = ?, metric = ?, operator = ?,
           threshold = ?, duration_sec = ?, enabled = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.deviceId ?? null,
        next.metric,
        next.operator,
        next.threshold,
        Math.max(0, Math.round(next.durationSec)),
        next.enabled ? 1 : 0,
        id,
      );
    return this.getAlertRule(id);
  }

  deleteAlertRule(id: string): boolean {
    const res = this.db.prepare("DELETE FROM alert_rules WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ---- alerts --------------------------------------------------------------

  findActiveAlert(ruleId: string, deviceId: string): AlertRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM alerts WHERE rule_id = ? AND device_id = ? AND state = 'active'",
      )
      .get(ruleId, deviceId) as AlertRow | undefined;
    return row ?? null;
  }

  createAlert(
    rule: AlertRule,
    deviceId: string,
    value: number,
    now: number,
  ): AlertRow {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO alerts (id, rule_id, device_id, value, state, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(id, rule.id, deviceId, value, now, now);
    return this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as unknown as AlertRow;
  }

  touchAlert(id: string, value: number, now: number): void {
    this.db
      .prepare("UPDATE alerts SET value = ?, last_seen_at = ? WHERE id = ?")
      .run(value, now, id);
  }

  resolveAlert(id: string, now: number): void {
    this.db
      .prepare("UPDATE alerts SET state = 'resolved', resolved_at = ? WHERE id = ?")
      .run(now, id);
  }

  /** List alerts, newest first. */
  listAlerts(state: "active" | "resolved" | "all", limit: number): Alert[] {
    const where = state === "all" ? "" : "WHERE state = ?";
    const params = state === "all" ? [limit] : [state, limit];
    const rows = this.db
      .prepare(
        `SELECT a.*, d.hostname AS device_hostname, r.name AS rule_name,
                r.metric AS rule_metric, r.operator AS rule_operator,
                r.threshold AS rule_threshold
         FROM alerts a
         LEFT JOIN devices d ON d.id = a.device_id
         LEFT JOIN alert_rules r ON r.id = a.rule_id
         ${where}
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...params) as unknown as (AlertRow & {
      device_hostname: string | null;
      rule_name: string | null;
      rule_metric: string | null;
      rule_operator: string | null;
      rule_threshold: number | null;
    })[];
    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      ruleName: row.rule_name ?? "deleted rule",
      deviceId: row.device_id,
      deviceHostname: row.device_hostname ?? "unknown",
      metric: (row.rule_metric ?? "cpu_usage") as Alert["metric"],
      operator: (row.rule_operator ?? ">") as Alert["operator"],
      threshold: row.rule_threshold ?? 0,
      value: row.value,
      message: buildAlertMessage(
        row.device_hostname ?? "unknown",
        row.rule_metric ?? "cpu_usage",
        row.rule_operator ?? ">",
        row.rule_threshold ?? 0,
        row.value,
      ),
      state: row.state as Alert["state"],
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      resolvedAt: row.resolved_at,
    }));
  }

  deviceHostname(deviceId: string): string {
    const row = this.db
      .prepare("SELECT hostname FROM devices WHERE id = ?")
      .get(deviceId) as { hostname: string } | undefined;
    return row?.hostname ?? "unknown";
  }

  // ---- jobs -----------------------------------------------------------------

  createJob(
    id: string,
    name: string,
    script: string,
    timeoutSec: number,
    createdBy: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, name, script, timeout_sec, status, created_by, created_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(id, name, script, timeoutSec, createdBy, Date.now());
  }

  addJobResult(
    jobId: string,
    deviceId: string,
    status: JobResult["status"],
    note?: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO job_results (job_id, device_id, status, stdout, stderr)
         VALUES (?, ?, ?, '', ?)`,
      )
      .run(jobId, deviceId, status, note ?? "");
  }

  jobResultExists(jobId: string, deviceId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM job_results WHERE job_id = ? AND device_id = ?")
      .get(jobId, deviceId);
    return row !== undefined;
  }

  markJobResultStarted(jobId: string, deviceId: string): void {
    this.db
      .prepare(
        "UPDATE job_results SET status = 'running', started_at = ? WHERE job_id = ? AND device_id = ?",
      )
      .run(Date.now(), jobId, deviceId);
  }

  appendJobOutput(
    jobId: string,
    deviceId: string,
    stream: "stdout" | "stderr",
    data: string,
  ): void {
    const column = stream === "stdout" ? "stdout" : "stderr";
    const row = this.db
      .prepare(
        `SELECT ${column} AS out FROM job_results WHERE job_id = ? AND device_id = ?`,
      )
      .get(jobId, deviceId) as { out: string } | undefined;
    if (!row) return;
    const MAX = 200 * 1024; // cap stored output per stream
    const next = row.out.length >= MAX ? row.out : (row.out + data).slice(0, MAX);
    this.db
      .prepare(
        `UPDATE job_results SET ${column} = ? WHERE job_id = ? AND device_id = ?`,
      )
      .run(next, jobId, deviceId);
  }

  finishJobResult(
    jobId: string,
    deviceId: string,
    status: JobResult["status"],
    exitCode: number | null,
    note?: string,
  ): void {
    const sets: string[] = ["status = ?", "exit_code = ?", "finished_at = ?"];
    const params: (string | number | null)[] = [status, exitCode, Date.now()];
    if (note) {
      sets.push("stderr = stderr || ?");
      params.push(note);
    }
    this.db
      .prepare(
        `UPDATE job_results SET ${sets.join(", ")} WHERE job_id = ? AND device_id = ?`,
      )
      .run(...params, jobId, deviceId);
  }

  /** Mark every non-terminal result of a job as the given status. */
  finishAllJobResults(
    jobId: string,
    status: JobResult["status"],
    note?: string,
  ): void {
    const sets: string[] = ["status = ?", "finished_at = ?"];
    const params: (string | number)[] = [status, Date.now()];
    if (note) {
      sets.push("stderr = stderr || ?");
      params.push(note);
    }
    this.db
      .prepare(
        `UPDATE job_results SET ${sets.join(", ")}
         WHERE job_id = ? AND status IN ('pending', 'running')`,
      )
      .run(...params, jobId);
  }

  getJob(jobId: string): JobSummary | null {
    const row = this.db
      .prepare(
        `SELECT j.*, r.total, r.success, r.failed, r.skipped, r.pending, r.running
         FROM jobs j
         LEFT JOIN (
           SELECT job_id,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
           FROM job_results GROUP BY job_id
         ) r ON r.job_id = j.id
         WHERE j.id = ?`,
      )
      .get(jobId) as JobRow | undefined;
    return row ? rowToJobSummary(row) : null;
  }

  listJobs(): JobSummary[] {
    const rows = this.db
      .prepare(
        `SELECT j.*, r.total, r.success, r.failed, r.skipped, r.pending, r.running
         FROM jobs j
         LEFT JOIN (
           SELECT job_id,
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
             SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
             SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
           FROM job_results GROUP BY job_id
         ) r ON r.job_id = j.id
         ORDER BY j.created_at DESC LIMIT 100`,
      )
      .all() as unknown as JobRow[];
    return rows.map(rowToJobSummary);
  }

  getJobResults(jobId: string): JobResult[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, d.hostname AS device_hostname
         FROM job_results r
         LEFT JOIN devices d ON d.id = r.device_id
         WHERE r.job_id = ?
         ORDER BY d.hostname ASC`,
      )
      .all(jobId) as unknown as JobResultRow[];
    return rows.map((r) => ({
      jobId: r.job_id,
      deviceId: r.device_id,
      deviceHostname: r.device_hostname ?? r.device_id,
      status: r.status as JobResult["status"],
      exitCode: r.exit_code,
      stdout: r.stdout,
      stderr: r.stderr,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }));
  }

  /** Returns the devices with non-terminal results for a job. */
  listActiveJobResultDevices(jobId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT device_id FROM job_results WHERE job_id = ? AND status IN ('pending', 'running')",
      )
      .all(jobId) as { device_id: string }[];
    return rows.map((r) => r.device_id);
  }

  setJobStatus(jobId: string, status: JobSummary["status"]): void {
    this.db
      .prepare(
        "UPDATE jobs SET status = ?, finished_at = ? WHERE id = ? AND status = 'running'",
      )
      .run(status, Date.now(), jobId);
  }

  deleteJob(jobId: string): boolean {
    this.db.prepare("DELETE FROM job_results WHERE job_id = ?").run(jobId);
    const res = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    return res.changes > 0;
  }

  /** Devices with non-terminal results for any running job. */
  listActiveResultsForDevice(deviceId: string): { job_id: string }[] {
    return this.db
      .prepare(
        `SELECT r.job_id FROM job_results r
         JOIN jobs j ON j.id = r.job_id
         WHERE r.device_id = ? AND r.status IN ('pending', 'running') AND j.status = 'running'`,
      )
      .all(deviceId) as { job_id: string }[];
  }

  // ---- OS update info ------------------------------------------------------

  setDeviceUpdateInfo(
    deviceId: string,
    pendingUpdates: number | null,
    checkedAt: number,
  ): void {
    this.db
      .prepare(
        "UPDATE devices SET pending_updates = ?, update_checked_at = ? WHERE id = ?",
      )
      .run(pendingUpdates, checkedAt, deviceId);
  }

  listDeviceUpdateInfo(): {
    deviceId: string;
    deviceHostname: string;
    os: string;
    osVersion: string;
    agentVersion: string;
    pendingUpdates: number | null;
    updateCheckedAt: number | null;
    online: boolean;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, hostname, os, os_version, agent_version,
                pending_updates, update_checked_at, online
         FROM devices ORDER BY online DESC, hostname ASC`,
      )
      .all() as unknown as {
      id: string;
      hostname: string;
      os: string;
      os_version: string;
      agent_version: string;
      pending_updates: number | null;
      update_checked_at: number | null;
      online: number;
    }[];
    return rows.map((r) => ({
      deviceId: r.id,
      deviceHostname: r.hostname,
      os: r.os,
      osVersion: r.os_version,
      agentVersion: r.agent_version,
      pendingUpdates: r.pending_updates,
      updateCheckedAt: r.update_checked_at,
      online: r.online === 1,
    }));
  }

  // ---- agent updates ---------------------------------------------------------

  createAgentUpdate(
    id: string,
    deviceId: string,
    url: string,
    sha256: string,
    fromVersion: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO agent_updates (id, device_id, url, sha256, status, from_version, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, deviceId, url, sha256, fromVersion, Date.now());
  }

  getAgentUpdate(id: string): AgentUpdate | null {
    const row = this.db
      .prepare(
        `SELECT u.*, d.hostname AS device_hostname
         FROM agent_updates u LEFT JOIN devices d ON d.id = u.device_id
         WHERE u.id = ?`,
      )
      .get(id) as unknown as AgentUpdateRow | undefined;
    return row ? rowToAgentUpdate(row) : null;
  }

  listAgentUpdates(limit = 100): AgentUpdate[] {
    const rows = this.db
      .prepare(
        `SELECT u.*, d.hostname AS device_hostname
         FROM agent_updates u LEFT JOIN devices d ON d.id = u.device_id
         ORDER BY u.created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as AgentUpdateRow[];
    return rows.map(rowToAgentUpdate);
  }

  setAgentUpdateStatus(
    id: string,
    status: UpdateStatus,
    error?: string,
  ): void {
    const finished = status === "completed" || status === "failed";
    this.db
      .prepare(
        `UPDATE agent_updates SET status = ?, error = ?, finished_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(status, error ?? null, finished ? Date.now() : null, id);
  }

  markAgentUpdateCompleted(id: string, toVersion: string): void {
    this.db
      .prepare(
        `UPDATE agent_updates SET status = 'completed', to_version = ?, finished_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed')`,
      )
      .run(toVersion, Date.now(), id);
  }

  /** In-flight update for a device (only one at a time). */
  findInFlightUpdate(deviceId: string): { id: string } | null {
    const row = this.db
      .prepare(
        `SELECT id FROM agent_updates
         WHERE device_id = ? AND status IN ('pending', 'downloading', 'verifying', 'restarting')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(deviceId) as { id: string } | undefined;
    return row ?? null;
  }

  // ---- API keys ----------------------------------------------------------------

  createApiKey(userId: number, name: string, tokenHash: string): ApiKeyInfo {
    const id = randomUUID();
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO api_keys (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, userId, name, tokenHash, createdAt);
    return { id, name, createdAt, lastUsedAt: null };
  }

  listApiKeys(userId: number): ApiKeyInfo[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, created_at, last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(userId) as unknown as {
      id: string;
      name: string;
      created_at: number;
      last_used_at: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  deleteApiKey(userId: number, keyId: string): boolean {
    const res = this.db
      .prepare("DELETE FROM api_keys WHERE id = ? AND user_id = ?")
      .run(keyId, userId);
    return res.changes > 0;
  }

  /** Resolve an API key token to its owner, updating last_used_at. */
  findUserByApiToken(tokenHash: string): { id: number; username: string; role: string } | null {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.role FROM api_keys k
         JOIN users u ON u.id = k.user_id
         WHERE k.token_hash = ?`,
      )
      .get(tokenHash) as { id: number; username: string; role: string } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE token_hash = ?")
      .run(Date.now(), tokenHash);
    return row;
  }

  // ---- audit log ------------------------------------------------------------------

  addAuditEntry(
    entry: Omit<AuditEntry, "id" | "ts"> & { userId?: number | null },
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_log (ts, user_id, username, action, target, ip, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        Date.now(),
        entry.userId ?? null,
        entry.username,
        entry.action,
        entry.target,
        entry.ip,
        entry.meta,
      );
  }

  listAuditEntries(limit = 200): AuditEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?",
      )
      .all(limit) as unknown as {
      id: number;
      ts: number;
      username: string;
      action: string;
      target: string | null;
      ip: string | null;
      meta: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      username: r.username,
      action: r.action,
      target: r.target,
      ip: r.ip,
      meta: r.meta,
    }));
  }

  // ---- installers -----------------------------------------------------------

  createInstaller(record: InstallerInfo): void {
    this.db
      .prepare(
        `INSERT INTO installers (id, name, filename, target, deployment_id, sha256, size, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.name,
        record.filename,
        record.target,
        record.deploymentId,
        record.sha256,
        record.size,
        record.createdAt,
        record.createdBy,
      );
  }

  listInstallers(): InstallerInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM installers ORDER BY created_at DESC LIMIT 100")
      .all() as unknown as InstallerRow[];
    return rows.map(rowToInstaller);
  }

  getInstaller(id: string): InstallerInfo | null {
    const row = this.db
      .prepare("SELECT * FROM installers WHERE id = ?")
      .get(id) as unknown as InstallerRow | undefined;
    return row ? rowToInstaller(row) : null;
  }

  deleteInstaller(id: string): boolean {
    const res = this.db.prepare("DELETE FROM installers WHERE id = ?").run(id);
    return res.changes > 0;
  }
}

interface InstallerRow {
  id: string;
  name: string;
  filename: string;
  target: string;
  deployment_id: string;
  sha256: string;
  size: number;
  created_at: number;
  created_by: string;
}

function rowToInstaller(row: InstallerRow): InstallerInfo {
  return {
    id: row.id,
    name: row.name,
    filename: row.filename,
    target: row.target as InstallerInfo["target"],
    deploymentId: row.deployment_id,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function rowToDevice(row: DeviceRow): Device {
  let drives: DriveInfo[] = [];
  try {
    drives = JSON.parse(row.drives_json) as DriveInfo[];
  } catch {
    drives = [];
  }
  return {
    id: row.id,
    hostname: row.hostname,
    os: row.os,
    osVersion: row.os_version,
    platform: row.platform,
    arch: row.arch,
    cpuModel: row.cpu_model,
    cpuCount: row.cpu_count,
    totalMem: row.total_mem,
    drives,
    agentVersion: row.agent_version,
    lastIp: row.last_ip,
    cpuUsage: row.cpu_usage,
    memUsed: row.mem_used,
    uptime: row.uptime,
    online: row.online === 1,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    deploymentId: row.deployment_id ?? null,
  };
}

interface AlertRuleRow {
  id: string;
  name: string;
  device_id: string | null;
  metric: string;
  operator: string;
  threshold: number;
  duration_sec: number;
  enabled: number;
  created_at: number;
}

interface AlertRow {
  id: string;
  rule_id: string;
  device_id: string;
  value: number;
  state: string;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
}

interface JobRow {
  id: string;
  name: string;
  script: string;
  timeout_sec: number;
  status: string;
  created_by: string;
  created_at: number;
  finished_at: number | null;
  total: number | null;
  success: number | null;
  failed: number | null;
  skipped: number | null;
  pending: number | null;
  running: number | null;
}

interface JobResultRow {
  job_id: string;
  device_id: string;
  device_hostname: string | null;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  started_at: number | null;
  finished_at: number | null;
}

interface AgentUpdateRow {
  id: string;
  device_id: string;
  device_hostname: string | null;
  url: string;
  sha256: string;
  status: string;
  from_version: string;
  to_version: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

function rowToAgentUpdate(row: AgentUpdateRow): AgentUpdate {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceHostname: row.device_hostname ?? row.device_id,
    url: row.url,
    sha256: row.sha256,
    status: row.status as UpdateStatus,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    error: row.error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function rowToJobSummary(row: JobRow): JobSummary {
  return {
    id: row.id,
    name: row.name,
    script: row.script,
    timeoutSec: row.timeout_sec,
    status: row.status as JobSummary["status"],
    createdAt: row.created_at,
    createdBy: row.created_by,
    finishedAt: row.finished_at,
    total: row.total ?? 0,
    success: row.success ?? 0,
    failed: row.failed ?? 0,
    skipped: row.skipped ?? 0,
    pending: row.pending ?? 0,
    running: row.running ?? 0,
  };
}

function rowToRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    deviceId: row.device_id,
    metric: row.metric as AlertRule["metric"],
    operator: row.operator as AlertRule["operator"],
    threshold: row.threshold,
    durationSec: row.duration_sec,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function buildAlertMessage(
  hostname: string,
  metric: string,
  operator: string,
  threshold: number,
  value: number,
): string {
  const label: Record<string, string> = {
    cpu_usage: "CPU usage",
    mem_pct: "memory usage",
    disk_pct: "disk usage",
  };
  return `${hostname}: ${label[metric] ?? metric} ${operator} ${threshold}% (current ${value.toFixed(1)}%)`;
}
