/**
 * Remote desktop hub: relays screen frames and input between a browser
 * WebSocket and an agent's screen session.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type {
  AgentMessage,
  ScreenClientMessage,
  ScreenServerMessage,
  ServerMessage,
} from "@openrmm/shared";
import type { Store } from "./db.js";
import { requireAdmin } from "./routes/auth.js";
import type { AgentSockets } from "./routes/agent.js";
import { audit } from "./audit.js";

const DEFAULT_SCALE = 0.75;

interface ScreenSession {
  sessionId: string;
  deviceId: string;
  browser: WebSocket | null;
  started: boolean;
  createdAt: number;
}

function sendBrowser(socket: WebSocket | null, msg: ScreenServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendAgent(socket: WebSocket | undefined, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class ScreenHub {
  private sessions = new Map<string, ScreenSession>();

  create(deviceId: string): ScreenSession {
    const session: ScreenSession = {
      sessionId: randomUUID(),
      deviceId,
      browser: null,
      started: false,
      createdAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): ScreenSession | undefined {
    return this.sessions.get(sessionId);
  }

  attachBrowser(sessionId: string, socket: WebSocket): ScreenSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.browser && session.browser !== socket) {
      session.browser.close();
    }
    session.browser = socket;
    return session;
  }

  handleAgentMessage(msg: AgentMessage): void {
    if (
      msg.type !== "screen_started" &&
      msg.type !== "screen_frame" &&
      msg.type !== "screen_error" &&
      msg.type !== "screen_stopped"
    ) {
      return;
    }
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;
    switch (msg.type) {
      case "screen_started":
        session.started = true;
        sendBrowser(session.browser, { type: "started", width: msg.width, height: msg.height });
        break;
      case "screen_frame":
        sendBrowser(session.browser, { type: "frame", seq: msg.seq, data: msg.data });
        break;
      case "screen_error":
        sendBrowser(session.browser, { type: "error", message: msg.error });
        this.remove(msg.sessionId);
        break;
      case "screen_stopped":
        sendBrowser(session.browser, { type: "stopped" });
        this.remove(msg.sessionId);
        break;
    }
  }

  end(sessionId: string, sockets: AgentSockets): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    sendAgent(sockets.get(session.deviceId), { type: "screen_stop", sessionId });
    this.remove(sessionId);
    return true;
  }

  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    if (session.browser && session.browser.readyState === session.browser.OPEN) {
      session.browser.close();
    }
  }
}

export function registerScreenRoutes(
  app: FastifyInstance,
  store: Store,
  sockets: AgentSockets,
  hub: ScreenHub,
): void {
  app.post("/api/devices/:id/screen", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = store.getDevice(id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.online) return reply.code(409).send({ error: "device is offline" });
    const agentSocket = sockets.get(id);
    if (!agentSocket) return reply.code(409).send({ error: "device is offline" });

    const session = hub.create(id);
    sendAgent(agentSocket, {
      type: "screen_start",
      sessionId: session.sessionId,
      scale: DEFAULT_SCALE,
    });
    audit(store, req, "screen.started", device.hostname);
    return reply.send({ sessionId: session.sessionId });
  });

  app.delete("/api/screens/:sessionId", { preHandler: requireAdmin }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const session = hub.get(sessionId);
    if (!session) return reply.code(404).send({ error: "session not found" });
    audit(store, req, "screen.ended", store.deviceHostname(session.deviceId));
    hub.end(sessionId, sockets);
    return reply.send({ ok: true });
  });

  app.get("/ws/screen", { websocket: true }, (socket: WebSocket, req) => {
    if (!req.session || req.session.role !== "admin") {
      sendBrowser(socket, { type: "error", message: "not authenticated" });
      socket.close();
      return;
    }
    const { sessionId } = req.query as { sessionId?: string };
    if (!sessionId) {
      sendBrowser(socket, { type: "error", message: "missing sessionId" });
      socket.close();
      return;
    }
    const session = hub.attachBrowser(sessionId, socket);
    if (!session) {
      sendBrowser(socket, { type: "error", message: "unknown screen session" });
      socket.close();
      return;
    }

    socket.on("message", (raw) => {
      let msg: ScreenClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ScreenClientMessage;
      } catch {
        return;
      }
      if (msg.type === "input") {
        sendAgent(sockets.get(session.deviceId), {
          type: "screen_input",
          sessionId,
          input: msg.input,
        });
      } else if (msg.type === "ping") {
        // keepalive; no reply needed
      }
    });

    socket.on("close", () => {
      if (hub.get(sessionId)) {
        hub.end(sessionId, sockets);
      }
    });
  });
}
