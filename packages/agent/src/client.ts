/**
 * The agent's connection loop: register over HTTP, then hold a WebSocket
 * and send heartbeats. Reconnects with backoff forever.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import {
  PROTOCOL_VERSION,
  type AgentMessage,
  type RegisterResponse,
  type ServerMessage,
} from "@openrmm/shared";
import type { AgentConfig } from "./config.js";
import { collectMachineInfo, collectMetrics } from "./inventory.js";
import { createShellManager } from "./shells.js";
import { createJobManager } from "./jobs.js";
import { createUpdateManager } from "./updates.js";
import { collectPendingUpdates } from "./pending.js";

export interface AgentClient {
  /** Runs until the process is killed. Never resolves. */
  run(): Promise<never>;
  stop(): void;
}

const WS_TIMEOUT_MS = 10_000;
/** No server traffic for this long means the connection is dead. Must be
 *  comfortably longer than the server's ping interval (10s). */
const WATCHDOG_MS = 30_000;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

export function createAgentClient(config: AgentConfig, log: (msg: string) => void): AgentClient {
  let stopped = false;
  let backoff = BACKOFF_BASE_MS;
  let socket: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const shells = createShellManager(send);
  const jobs = createJobManager(send);
  const updates = createUpdateManager(send, log);
  let lastUpdateCheck = 0;
  let updateCheckRunning = false;

  /** Report OS pending-update counts, at most once per 6 hours. */
  async function checkPendingUpdates(): Promise<void> {
    if (updateCheckRunning || Date.now() - lastUpdateCheck < 6 * 60 * 60 * 1000) return;
    updateCheckRunning = true;
    try {
      const pending = await collectPendingUpdates();
      lastUpdateCheck = Date.now();
      send({ type: "update_info", pendingUpdates: pending, checkedAt: lastUpdateCheck });
    } catch {
      // Best-effort metric; never break the connection loop.
    } finally {
      updateCheckRunning = false;
    }
  }

  async function register(): Promise<RegisterResponse> {
    const res = await fetch(`${config.serverUrl}/api/agent/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        installKey: config.installKey,
        clientId: config.clientId,
        machine: collectMachineInfo(),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`registration failed (HTTP ${res.status}): ${text}`);
    }
    return (await res.json()) as RegisterResponse;
  }

  function wsUrl(reg: RegisterResponse): string {
    const base = config.serverUrl.replace(/^http/, "ws");
    return `${base}/ws/agent?deviceId=${encodeURIComponent(reg.deviceId)}&token=${encodeURIComponent(reg.token)}`;
  }

  function clearTimers(): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (watchdogTimer) clearTimeout(watchdogTimer);
    heartbeatTimer = null;
    watchdogTimer = null;
  }

  function send(msg: AgentMessage): void {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  function onHeartbeatTick(): void {
    const metrics = collectMetrics();
    send({ type: "heartbeat", ts: Date.now(), metrics });
    // If the server doesn't talk back for two heartbeat intervals, the
    // connection is dead; force a reconnect.
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      log("watchdog: no server traffic, reconnecting");
      socket?.close();
    }, WATCHDOG_MS);
  }

  async function connectOnce(): Promise<void> {
    const reg = await register();
    const url = wsUrl(reg);

    // Resolves only when the socket closes (or times out), so the caller
    // reconnects exactly when this connection has ended.
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url);
      socket = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        send({ type: "hello", protocolVersion: PROTOCOL_VERSION });
        void checkPendingUpdates();
        backoff = BACKOFF_BASE_MS;
        log(`connected to ${config.serverUrl}`);
        // Prime the CPU sampler so the first heartbeat has real numbers.
        collectMetrics();
        heartbeatTimer = setInterval(onHeartbeatTick, reg.heartbeatIntervalMs);
      };

      ws.onmessage = (event) => {
        if (watchdogTimer) {
          clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "ping") {
          send({ type: "pong", ts: msg.ts });
        } else if (msg.type === "error") {
          log(`server error: ${msg.message}`);
        } else if (
          msg.type === "shell_start" ||
          msg.type === "shell_input" ||
          msg.type === "shell_end"
        ) {
          shells.handle(msg);
        } else if (msg.type === "job_run" || msg.type === "job_cancel") {
          jobs.handle(msg);
        } else if (msg.type === "update_run") {
          updates.handle(msg);
        }
      };

      ws.onerror = () => {
        // 'close' always follows an error; let the close handler manage state.
      };

      ws.onclose = (event) => {
        clearTimers();
        shells.closeAll();
        jobs.closeAll();
        if (socket === ws) socket = null;
        if (opened) {
          log(`disconnected (code ${event.code}${event.reason ? `, ${event.reason}` : ""})`);
        }
        resolve();
      };

      // If the handshake never completes, force a close so we can retry.
      setTimeout(() => {
        if (!opened) ws.close();
      }, WS_TIMEOUT_MS);
    });
  }

  async function run(): Promise<never> {
    log(`starting agent ${config.clientId} (home: ${process.env.RMM_AGENT_HOME ?? "default"})`);
    while (!stopped) {
      try {
        await connectOnce();
        // Clean disconnect: wait a beat, then reconnect immediately.
        await new Promise((r) => setTimeout(r, 1_000));
      } catch (err) {
        log(`connection failed: ${(err as Error).message} — retrying in ${Math.round(backoff / 1000)}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
    throw new Error("agent stopped");
  }

  return {
    run,
    stop: () => {
      stopped = true;
      clearTimers();
      shells.closeAll();
      jobs.closeAll();
      socket?.close();
    },
  };
}
