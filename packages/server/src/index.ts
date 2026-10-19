/**
 * OpenRMM server entry point.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import fastifyMultipart from "@fastify/multipart";
import { OFFLINE_AFTER_MS, PROTOCOL_VERSION, type UserRole } from "@openrmm/shared";
import { loadConfig } from "./config.js";
import { randomHex, sha256Hex } from "./crypto.js";
import { Store } from "./db.js";
import { getSessionCookie, verifySession, type Session } from "./session.js";
import { registerAgentRoutes, createSocketRegistry } from "./routes/agent.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerUpdateRoutes } from "./routes/updates.js";
import { registerApiKeyRoutes } from "./routes/keys.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerProcessRoutes } from "./routes/processes.js";
import { ShellHub, registerShellRoutes } from "./shell.js";
import { ScreenHub, registerScreenRoutes } from "./screen.js";
import { AlertService } from "./alerts.js";
import { JobsService } from "./jobs.js";
import { UpdatesService } from "./updates.js";
import { TransfersService } from "./transfers.js";
import { ProcessesService } from "./processes.js";

const VERSION = "0.1.0";
const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const config = loadConfig();

  const sessionSecret = config.sessionSecret || randomHex(32);
  if (!config.sessionSecret) {
    console.warn("[warn] RMM_SESSION_SECRET not set: dashboard sessions will not survive restarts.");
  }

  const dbPath = path.join(config.dataDir, "rmm.db");
  const store = new Store(dbPath);

  // Seed admin account on first boot.
  const adminUser = process.env.RMM_ADMIN_USERNAME ?? "admin";
  const seeded = store.ensureAdminUser(adminUser, config.adminPassword);
  if (seeded && config.adminPassword === "changeme") {
    console.warn("[warn] Admin password is the default 'changeme'. Set RMM_ADMIN_PASSWORD before exposing this server!");
  }

  // Install key: from env, or generated once and persisted.
  const installKey = store.getOrCreateInstallKey(config.installKey === null);
  if (config.installKey) {
    store.setSetting("install_key", config.installKey);
  }

  const sockets = createSocketRegistry();
  const shellHub = new ShellHub();
  const screenHub = new ScreenHub();
  const alertService = new AlertService(store);
  const jobsService = new JobsService(store, sockets);
  const updatesService = new UpdatesService(store, sockets);
  const transfersService = new TransfersService(store, sockets, config.dataDir);
  const processesService = new ProcessesService(sockets);

  const app = Fastify({
    logger: { level: process.env.RMM_LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  // ---- Plugins (cookie first: its onRequest hook parses cookies) ------
  await app.register(fastifyCookie);
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });
  await app.register(fastifyMultipart, {
    limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  });

  // ---- Session resolution on every request ----------------------------
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    // Bearer token (API key) takes precedence over the session cookie.
    const authHeader = req.headers.authorization;
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      const user = token ? store.findUserByApiToken(sha256Hex(token)) : null;
      req.session = user
        ? ({ userId: user.id, username: user.username, role: user.role as UserRole } satisfies Session)
        : null;
      return;
    }

    const userId = verifySession(sessionSecret, getSessionCookie(req));
    if (!userId) {
      req.session = null;
      return;
    }
    const user = store.db
      .prepare("SELECT username, role FROM users WHERE id = ?")
      .get(userId) as { username: string; role: string } | undefined;
    req.session = user
      ? ({ userId, username: user.username, role: user.role as UserRole } satisfies Session)
      : null;
  });

  // ---- Routes ----------------------------------------------------------
  app.get("/api/health", async () => ({
    ok: true,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
  }));

  registerAgentRoutes(app, store, sockets, shellHub, screenHub, alertService, jobsService, updatesService, transfersService, processesService);
  registerAuthRoutes(app, store, sessionSecret);
  registerDeviceRoutes(app, store);
  registerAlertRoutes(app, store);
  registerJobRoutes(app, store, jobsService);
  registerUserRoutes(app, store);
  registerUpdateRoutes(app, store, updatesService);
  registerApiKeyRoutes(app, store);
  registerAuditRoutes(app, store);
  registerFileRoutes(app, store, transfersService);
  registerProcessRoutes(app, store, processesService);
  registerShellRoutes(app, store, sockets, shellHub);
  registerScreenRoutes(app, store, sockets, screenHub);

  // ---- Serve the built dashboard (if present) --------------------------
  const dashboardDist = path.resolve(here, "..", "..", "dashboard", "dist");
  if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
    await app.register(fastifyStatic, { root: dashboardDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api") || req.raw.url?.startsWith("/ws")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html");
    });
    app.log.info({ dashboardDist }, "serving dashboard build");
  } else {
    app.log.warn("dashboard build not found; run `npm run build` to serve it from this server");
  }

  // ---- Offline sweeper ---------------------------------------------------
  const sweeper = setInterval(() => {
    try {
      store.sweepOffline(OFFLINE_AFTER_MS);
      jobsService.sweepTimeouts();
    } catch (err) {
      app.log.error({ err }, "offline sweep failed");
    }
  }, 10_000);
  app.addHook("onClose", async () => clearInterval(sweeper));

  // ---- Listen -------------------------------------------------------------
  const tls = config.tls
    ? {
        https: {
          cert: fs.readFileSync(config.tls.cert),
          key: fs.readFileSync(config.tls.key),
        },
      }
    : undefined;

  await app.listen({ host: config.host, port: config.port, ...tls });

  const proto = tls ? "https" : "http";
  app.log.info(
    `OpenRMM server v${VERSION} listening on ${proto}://${config.host}:${config.port}`,
  );
  app.log.info({ dbPath }, "database ready");
  app.log.info(
    `Admin user '${adminUser}'${seeded ? " seeded with the configured password" : " (existing account)"}`,
  );
  if (!config.tls) {
    app.log.warn("TLS is disabled: agent and dashboard traffic is unencrypted. Set RMM_TLS_CERT/RMM_TLS_KEY or place a reverse proxy in front.");
  }
  if (config.installKey) {
    app.log.info(`Using install key from RMM_INSTALL_KEY (not logged).`);
  } else {
    app.log.info(`Install key (set RMM_INSTALL_KEY to override): ${installKey}`);
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error("Failed to start OpenRMM server:", err);
  process.exit(1);
});
