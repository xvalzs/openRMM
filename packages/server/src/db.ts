/**
 * SQLite storage backed by the Node.js built-in `node:sqlite` module.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Device, DriveInfo, MachineInfo, Metrics } from "@openrmm/shared";
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
