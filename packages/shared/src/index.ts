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
  | { type: "pong"; ts: number };

/** Messages sent by the server over the WebSocket. */
export type ServerMessage =
  | { type: "ping"; ts: number }
  | { type: "error"; message: string };

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
