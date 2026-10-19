/**
 * Machine inventory and live metrics collection. Pure node:* APIs,
 * works on Windows and macOS (and Linux).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DriveInfo, MachineInfo, Metrics } from "@openrmm/shared";
import { getSelfPath } from "./paths.js";

declare global {
  // Injected at bundle time (see scripts/package.mjs) so the packaged
  // single-file build reports its version without a package.json nearby.
  var __OPENRMM_AGENT_VERSION__: string | undefined;
}

export function agentVersion(): string {
  if (typeof globalThis.__OPENRMM_AGENT_VERSION__ === "string") {
    return globalThis.__OPENRMM_AGENT_VERSION__;
  }
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(getSelfPath()), "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function osName(): string {
  switch (process.platform) {
    case "win32":
      return "Windows";
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

function osVersion(): string {
  // os.version() exists on Windows and returns e.g. "Windows 11 Pro".
  return typeof os.version === "function" && os.version()
    ? os.version()
    : os.release();
}

/** Primary filesystem to monitor: C:\ on Windows, / elsewhere. */
function primaryMount(): string {
  if (process.platform === "win32") {
    return path.parse(process.cwd()).root;
  }
  return "/";
}

function statDrive(mount: string): DriveInfo | null {
  try {
    const stat = fs.statfsSync(mount, { bigint: false });
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
    return { mount, total, free };
  } catch {
    return null;
  }
}

export function collectMachineInfo(): MachineInfo {
  const drives: DriveInfo[] = [];
  const primary = statDrive(primaryMount());
  if (primary) drives.push(primary);
  // On macOS also report the data volume when it differs from "/".
  if (process.platform === "darwin") {
    const data = statDrive("/System/Volumes/Data");
    if (data && !drives.some((d) => d.mount === data.mount)) drives.push(data);
  }

  return {
    hostname: os.hostname(),
    os: osName(),
    osVersion: osVersion(),
    platform: process.platform,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cpuCount: os.cpus().length,
    totalMem: os.totalmem(),
    drives,
    agentVersion: agentVersion(),
  };
}

// ---- Live metrics --------------------------------------------------------

let lastCpuTimes: os.CpuInfo[] | null = null;

/** CPU busy percentage since the previous call. First call returns 0. */
export function sampleCpuUsage(): number {
  const now = os.cpus();
  const prev = lastCpuTimes;
  lastCpuTimes = now;
  if (!prev || prev.length !== now.length) return 0;

  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < now.length; i++) {
    const a = prev[i]!.times;
    const b = now[i]!.times;
    idleDelta += b.idle - a.idle;
    totalDelta +=
      b.user - a.user + b.nice - a.nice + b.sys - a.sys + b.idle - a.idle + b.irq - a.irq;
  }
  if (totalDelta <= 0) return 0;
  const busy = 1 - idleDelta / totalDelta;
  return Math.max(0, Math.min(100, busy * 100));
}

export function collectMetrics(): Metrics {
  const drives: DriveInfo[] = [];
  const primary = statDrive(primaryMount());
  if (primary) drives.push(primary);
  if (process.platform === "darwin") {
    const data = statDrive("/System/Volumes/Data");
    if (data && !drives.some((d) => d.mount === data.mount)) drives.push(data);
  }

  return {
    cpuUsage: sampleCpuUsage(),
    memTotal: os.totalmem(),
    memUsed: os.totalmem() - os.freemem(),
    drives,
    uptime: os.uptime(),
  };
}
