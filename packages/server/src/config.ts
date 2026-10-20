/**
 * Server configuration, read from environment variables.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  /** Shared secret that authorizes agent registration. */
  installKey: string | null;
  /** Initial admin password. Only used to seed the database on first boot. */
  adminPassword: string;
  /** HMAC secret for dashboard session cookies. Generated per-boot if unset. */
  sessionSecret: string;
  /** TLS config. Set `RMM_TLS_CERT` / `RMM_TLS_KEY` to serve over HTTPS/WSS. */
  tls: { cert: string; key: string } | null;
  /** Public URL agents should use to reach this server (installer builds). */
  publicUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // PaaS hosts (Railway, Render, …) inject the expected listen port via
  // PORT; RMM_PORT still takes precedence for self-hosted deployments.
  const rawPort = env.RMM_PORT ?? env.PORT ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`RMM_PORT must be a valid port number, got: ${rawPort}`);
  }
  return {
    host: env.RMM_HOST ?? "0.0.0.0",
    port,
    dataDir: env.RMM_DATA_DIR
      ? path.resolve(env.RMM_DATA_DIR)
      : path.resolve(here, "..", "..", "..", "..", "data"),
    installKey: env.RMM_INSTALL_KEY?.trim() || null,
    adminPassword: env.RMM_ADMIN_PASSWORD ?? "changeme",
    sessionSecret: env.RMM_SESSION_SECRET ?? "",
    tls:
      env.RMM_TLS_CERT && env.RMM_TLS_KEY
        ? { cert: env.RMM_TLS_CERT, key: env.RMM_TLS_KEY }
        : null,
    publicUrl: env.RMM_PUBLIC_URL?.trim() || null,
  };
}
