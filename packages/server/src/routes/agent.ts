/**
 * Agent-facing endpoints: HTTP registration + the persistent WebSocket
 * channel agents use for heartbeats and (later) command dispatch.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  type AgentMessage,
  type RegisterRequest,
  type RegisterResponse,
  type ServerMessage,
} from "@openrmm/shared";
import type { Store } from "../db.js";
import { randomHex, sha256Hex } from "../crypto.js";
import type { AlertService } from "../alerts.js";
import type { ShellHub } from "../shell.js";
import type { JobsService } from "../jobs.js";
import type { UpdatesService } from "../updates.js";

export interface AgentSockets {
  /** deviceId -> live socket (only the newest registration wins). */
  get(deviceId: string): WebSocket | undefined;
  set(deviceId: string, socket: WebSocket): void;
  /** Returns true if the given socket is still the live one for the device. */
  isLive(deviceId: string, socket: WebSocket): boolean;
  remove(deviceId: string, socket: WebSocket): void;
}

export function createSocketRegistry(): AgentSockets {
  const sockets = new Map<string, WebSocket>();
  return {
    get: (id) => sockets.get(id),
    set: (id, socket) => sockets.set(id, socket),
    isLive: (id, socket) => sockets.get(id) === socket,
    remove: (id, socket) => {
      if (sockets.get(id) === socket) sockets.delete(id);
    },
  };
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** How often the server pings agents to keep the channel healthy. */
const SERVER_PING_INTERVAL_MS = 10_000;

export function registerAgentRoutes(
  app: FastifyInstance,
  store: Store,
  sockets: AgentSockets,
  hub: ShellHub,
  alerts: AlertService,
  jobs: JobsService,
  updates: UpdatesService,
): void {
  // ---- Registration ---------------------------------------------------

  app.post("/api/agent/register", async (req, reply) => {
    const body = req.body as RegisterRequest;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "invalid request body" });
    }
    if (body.protocolVersion !== PROTOCOL_VERSION) {
      return reply.code(400).send({
        error: `unsupported protocol version ${body.protocolVersion}, server speaks ${PROTOCOL_VERSION}`,
      });
    }
    if (
      typeof body.installKey !== "string" ||
      typeof body.clientId !== "string" ||
      !body.clientId ||
      !body.machine
    ) {
      return reply.code(400).send({ error: "missing installKey, clientId, or machine" });
    }
    if (!store.verifyInstallKey(body.installKey)) {
      return reply.code(401).send({ error: "invalid install key" });
    }

    // Close any previous socket for this device: a re-registration rotates
    // the token, so the old channel is no longer trustworthy.
    const previous = sockets.get(body.clientId);
    if (previous) {
      send(previous, { type: "error", message: "re-registered" });
      previous.close();
    }

    const token = randomHex(32);
    const ip = req.ip;
    store.registerDevice(body.clientId, body.machine, sha256Hex(token), ip, Date.now());
    updates.onDeviceReconnect(body.clientId, body.machine.agentVersion);

    const response: RegisterResponse = {
      deviceId: body.clientId,
      token,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    };
    return reply.send(response);
  });

  // ---- WebSocket channel ----------------------------------------------

  app.get("/ws/agent", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const query = req.query as Record<string, string | undefined>;
    const deviceId = query.deviceId;
    const token = query.token;

    const fail = (message: string): void => {
      send(socket, { type: "error", message });
      socket.close();
    };

    if (!deviceId || !token || !store.verifyDeviceToken(deviceId, sha256Hex(token))) {
      return fail("unauthorized");
    }

    sockets.set(deviceId, socket);
    store.setDeviceOnline(deviceId, true);
    app.log.info({ deviceId }, "agent connected");

    // Actively ping the agent so a dead peer is detected on both sides
    // long before the offline sweeper would notice.
    const pingTimer = setInterval(
      () => send(socket, { type: "ping", ts: Date.now() }),
      SERVER_PING_INTERVAL_MS,
    );

    socket.on("message", (raw) => {
      let msg: AgentMessage;
      try {
        msg = JSON.parse(raw.toString()) as AgentMessage;
      } catch {
        return send(socket, { type: "error", message: "malformed message" });
      }
      switch (msg.type) {
        case "hello":
          break;
        case "heartbeat":
          if (msg.metrics) {
            store.applyHeartbeat(deviceId, msg.metrics, true);
            alerts.evaluate(deviceId, msg.metrics);
          }
          break;
        case "pong":
          break;
        case "shell_started":
        case "shell_data":
        case "shell_exit":
          hub.handleAgentMessage(msg);
          break;
        case "job_output":
          jobs.onOutputForDevice(msg.jobId, deviceId, msg.stream, msg.data);
          break;
        case "job_done":
          jobs.onDoneForDevice(msg.jobId, deviceId, msg.exitCode, msg.timedOut === true);
          break;
        case "update_info":
          updates.handleUpdateInfo(deviceId, msg.pendingUpdates, msg.checkedAt);
          break;
        case "update_status":
          updates.handleUpdateStatus(deviceId, msg.updateId, msg.status, msg.error);
          break;
        default:
          send(socket, { type: "error", message: `unknown message type: ${String((msg as { type?: string }).type)}` });
      }
    });

    socket.on("close", () => {
      clearInterval(pingTimer);
      sockets.remove(deviceId, socket);
      // Only mark offline if this socket was the live one (a re-registration
      // briefly overlaps the old socket's close event).
      if (!sockets.get(deviceId)) {
        store.setDeviceOnline(deviceId, false);
        jobs.onDeviceDisconnected(deviceId);
        app.log.info({ deviceId }, "agent disconnected");
      }
    });

    socket.on("error", (err) => {
      app.log.warn({ deviceId, err: err.message }, "agent socket error");
    });
  });
}
