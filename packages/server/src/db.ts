/**
 * SQLite storage backed by the Node.js built-in `node:sqlite` module.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Alert,
  AlertRule,
  AlertRuleInput,
  Device,
  DriveInfo,
  MachineInfo,
  Metrics,
} from "@openrmm/shared";
import { hashPassword, randomHex, safeEqualHex } from "./crypto.js";

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
    `);
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
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
      )
      .run(username, hashPassword(password), Date.now());
    return true;
  }

  findUserByUsername(username: string): { id: number; password_hash: string } | null {
    const row = this.db
      .prepare("SELECT id, password_hash FROM users WHERE username = ?")
      .get(username) as { id: number; password_hash: string } | undefined;
    return row ?? null;
  }

  // ---- devices --------------------------------------------------------

  /** Upsert a device and rotate its token. Returns the fresh token. */
  registerDevice(
    clientId: string,
    machine: MachineInfo,
    token: string,
    ip: string,
    firstSeen: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO devices (
           id, token_hash, hostname, os, os_version, platform, arch,
           cpu_model, cpu_count, total_mem, drives_json, agent_version,
           last_ip, first_seen, last_seen
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
