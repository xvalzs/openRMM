/**
 * Shell sessions: relays between a browser WebSocket and an agent's shell
 * process, using the agent's existing WebSocket channel.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { AgentMessage, ServerMessage, ShellClientMessage, ShellServerMessage } from "@openrmm/shared";
import type { Store } from "./db.js";
import { requireAdmin } from "./routes/auth.js";
import type { AgentSockets } from "./routes/agent.js";
import { audit } from "./audit.js";

interface ShellSession {
  sessionId: string;
  deviceId: string;
  browser: WebSocket | null;
  started: boolean;
  pid: number | null;
  createdAt: number;
}

function sendBrowser(socket: WebSocket | null, msg: ShellServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendAgent(socket: WebSocket | undefined, msg: ServerMessage): void {
  if (socket && socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class ShellHub {
  private sessions = new Map<string, ShellSession>();

  create(deviceId: string): ShellSession {
    const session: ShellSession = {
      sessionId: randomUUID(),
      deviceId,
      browser: null,
      started: false,
      pid: null,
      createdAt: Date.now(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): ShellSession | undefined {
    return this.sessions.get(sessionId);
  }

  attachBrowser(sessionId: string, socket: WebSocket): ShellSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    // Replace any previous browser socket for this session.
    if (session.browser && session.browser !== socket) {
      session.browser.close();
    }
    session.browser = socket;
    if (session.started) {
      sendBrowser(socket, { type: "started", pid: session.pid ?? 0 });
    }
    return session;
  }

  /** Agent-side messages: relay to the browser. */
  handleAgentMessage(msg: AgentMessage): void {
    if (msg.type !== "shell_started" && msg.type !== "shell_data" && msg.type !== "shell_exit") {
      return;
    }
    const session = this.sessions.get(msg.sessionId);
    if (!session) return;

    switch (msg.type) {
      case "shell_started":
        session.started = true;
        session.pid = msg.pid;
        sendBrowser(session.browser, { type: "started", pid: msg.pid });
        break;
      case "shell_data":
        sendBrowser(session.browser, { type: "data", data: msg.data });
        break;
      case "shell_exit":
        sendBrowser(session.browser, { type: "exited", code: msg.code });
        this.remove(msg.sessionId);
        break;
    }
  }

  /** Close the shell process on the agent and drop the session. */
  end(sessionId: string, sockets: AgentSockets): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    sendAgent(sockets.get(session.deviceId), { type: "shell_end", sessionId });
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

function shellForPlatform(platform: string): { shell: string; args: string[] } {
  switch (platform) {
    case "win32":
      return { shell: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "-"] };
    default:
      return { shell: "/bin/bash", args: ["--noprofile", "--norc"] };
  }
}

export function registerShellRoutes(
  app: FastifyInstance,
  store: Store,
  sockets: AgentSockets,
  hub: ShellHub,
): void {
  // ---- Create a shell session on an online device (admin only) -------------

  app.post("/api/devices/:id/shell", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = store.getDevice(id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    if (!device.online) return reply.code(409).send({ error: "device is offline" });

    const agentSocket = sockets.get(id);
    if (!agentSocket) {
      return reply.code(409).send({ error: "device is offline" });
    }

    const session = hub.create(id);
    const { shell, args } = shellForPlatform(device.platform);
    sendAgent(agentSocket, {
      type: "shell_start",
      sessionId: session.sessionId,
      shell,
      args,
    });
    audit(store, req, "shell.created", device.hostname, { shell });
    return reply.send({ sessionId: session.sessionId, shell });
  });

  // ---- End a shell session ---------------------------------------------------

  app.delete("/api/shells/:sessionId", { preHandler: requireAdmin }, async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const ended = hub.end(sessionId, sockets);
    if (!ended) return reply.code(404).send({ error: "session not found" });
    return reply.send({ ok: true });
  });

  // ---- Browser ↔ agent relay WebSocket ----------------------------------------

  app.get("/ws/shell", { websocket: true }, (socket: WebSocket, req) => {
    if (!req.session) {
      sendBrowser(socket, { type: "error", message: "not authenticated" });
      socket.close();
      return;
    }
    if (req.session.role !== "admin") {
      sendBrowser(socket, { type: "error", message: "admin role required" });
      socket.close();
      return;
    }
    const { sessionId } = req.query as { sessionId?: string };
    if (!sessionId) {
      sendBrowser(socket, { type: "error", message: "missing sessionId" });
      socket.close();
      return;
    }
    const session = hub.get(sessionId);
    if (!session) {
      sendBrowser(socket, { type: "error", message: "unknown shell session" });
      socket.close();
      return;
    }

    hub.attachBrowser(sessionId, socket);
    const agentSocket = () => sockets.get(session.deviceId);

    socket.on("message", (raw) => {
      let msg: ShellClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ShellClientMessage;
      } catch {
        return;
      }
      if (msg.type === "stdin") {
        sendAgent(agentSocket(), {
          type: "shell_input",
          sessionId,
          data: Buffer.from(msg.data, "utf8").toString("base64"),
        });
      } else if (msg.type === "ping") {
        sendBrowser(socket, { type: "pong", ts: msg.ts });
      }
    });

    socket.on("close", () => {
      // Browser went away: kill the shell on the agent.
      if (hub.get(sessionId)) {
        hub.end(sessionId, sockets);
      }
    });
  });
}
