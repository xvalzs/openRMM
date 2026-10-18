/**
 * OpenRMM shared protocol.
 *
 * This file is the single source of truth for the wire format spoken
 * between the agent, the server, and the dashboard.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Bumped when the agent/server wire protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** How often (ms) the agent sends a heartbeat while connected. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Devices are considered offline after this long without a heartbeat. */
export const OFFLINE_AFTER_MS = 45_000;

/** One mounted filesystem as reported by an agent. */
export interface DriveInfo {
  mount: string;
  total: number;
  free: number;
}

/** Static machine information collected once at agent startup. */
export interface MachineInfo {
  hostname: string;
  os: string;
  osVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  drives: DriveInfo[];
  agentVersion: string;
}

/** Live metrics sent with each heartbeat. */
export interface Metrics {
  cpuUsage: number; // percent, 0..100
  memTotal: number;
  memUsed: number;
  drives: DriveInfo[];
  uptime: number; // seconds
}

/** Payload for the agent registration HTTP call. */
export interface RegisterRequest {
  protocolVersion: number;
  installKey: string;
  clientId: string;
  machine: MachineInfo;
}

/** Response to a successful registration. */
export interface RegisterResponse {
  deviceId: string;
  token: string;
  heartbeatIntervalMs: number;
}

/** Messages sent by the agent over the WebSocket. */
export type AgentMessage =
  | { type: "hello"; protocolVersion: number }
  | { type: "heartbeat"; ts: number; metrics: Metrics }
  | { type: "pong"; ts: number }
  | { type: "shell_started"; sessionId: string; pid: number }
  | { type: "shell_data"; sessionId: string; data: string }
  | { type: "shell_exit"; sessionId: string; code: number | null };

/** Messages sent by the server over the WebSocket. */
export type ServerMessage =
  | { type: "ping"; ts: number }
  | { type: "error"; message: string }
  | { type: "shell_start"; sessionId: string; shell: string; args: string[] }
  | { type: "shell_input"; sessionId: string; data: string }
  | { type: "shell_end"; sessionId: string };

/** Browser → server messages on a shell channel WebSocket. */
export type ShellClientMessage =
  | { type: "stdin"; data: string }
  | { type: "ping"; ts: number };

/** Server → browser messages on a shell channel WebSocket. */
export type ShellServerMessage =
  | { type: "started"; pid: number }
  | { type: "data"; data: string }
  | { type: "exited"; code: number | null }
  | { type: "error"; message: string }
  | { type: "pong"; ts: number };

/** A device as returned by the dashboard REST API. */
export interface Device {
  id: string;
  hostname: string;
  os: string;
  osVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMem: number;
  drives: DriveInfo[];
  agentVersion: string;
  lastIp: string;
  cpuUsage: number;
  memUsed: number;
  uptime: number;
  online: boolean;
  firstSeen: number;
  lastSeen: number;
}

/** Response of `GET /api/devices`. */
export interface DeviceListResponse {
  devices: Device[];
  summary: {
    total: number;
    online: number;
  };
}

/** Response of `GET /api/auth/me` when logged in. */
export interface SessionInfo {
  username: string;
}

// ---- Alert rules ------------------------------------------------------------

export type AlertMetric = "cpu_usage" | "mem_pct" | "disk_pct";
export type AlertOperator = ">" | ">=" | "<" | "<=";

export interface AlertRule {
  id: string;
  name: string;
  /** null = applies to every device. */
  deviceId: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  /** The condition must hold this long (seconds) before an alert fires. */
  durationSec: number;
  enabled: boolean;
  createdAt: number;
}

export interface AlertRuleInput {
  name: string;
  deviceId?: string | null;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  durationSec: number;
  enabled?: boolean;
}

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  deviceId: string;
  deviceHostname: string;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  value: number;
  message: string;
  state: "active" | "resolved";
  createdAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
}

export interface AlertListResponse {
  alerts: Alert[];
}

export interface AlertSettings {
  webhookUrl: string;
}
