/**
 * Installer management endpoints (admin only).
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import fs from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Store } from "../db.js";
import type { InstallerBuilder, InstallerBuildInput } from "../installers.js";
import { requireAdmin } from "./auth.js";
import { audit } from "../audit.js";

interface InstallerBody {
  name?: string;
  target?: string;
  serverUrl?: string;
  installKey?: string;
  autoService?: boolean;
}

export function registerInstallerRoutes(
  app: FastifyInstance,
  store: Store,
  builder: InstallerBuilder,
  publicUrl: string | null,
): void {
  app.get("/api/installers", { preHandler: requireAdmin }, async () => ({
    installers: store.listInstallers(),
  }));

  app.post("/api/installers", { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as InstallerBody;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) {
      return reply.code(400).send({ error: "name is required (max 120 characters)" });
    }
    const target = body.target === "posix"
      ? "posix"
      : body.target === "windows-arm64"
        ? "windows-arm64"
        : body.target === "windows-zip"
          ? "windows-zip"
          : "windows-x64";
    if (body.serverUrl !== undefined && (typeof body.serverUrl !== "string" || !/^https?:\/\//.test(body.serverUrl))) {
      return reply.code(400).send({ error: "serverUrl must start with http:// or https://" });
    }
    if (body.installKey !== undefined && typeof body.installKey !== "string") {
      return reply.code(400).send({ error: "installKey must be a string" });
    }

    const serverUrl =
      body.serverUrl ||
      publicUrl ||
      `${req.protocol}://${req.headers.host ?? "localhost"}`;
    const installKey = body.installKey || store.getSetting("install_key") || "";
    if (!installKey) {
      return reply.code(400).send({ error: "no install key available on this server" });
    }

    const input: InstallerBuildInput = {
      name,
      target,
      serverUrl,
      installKey,
      autoService: body.autoService === true,
      createdBy: req.session!.username,
    };

    try {
      const installer = await builder.build(input);
      audit(store, req, "installer.built", installer.filename, {
        target,
        deploymentId: installer.deploymentId,
        sha256: installer.sha256,
      });
      return reply.code(201).send(installer);
    } catch (err) {
      req.log.error({ err }, "installer build failed");
      return reply.code(500).send({ error: `build failed: ${(err as Error).message}` });
    }
  });

  app.get("/api/installers/:id/download", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const installer = store.getInstaller(id);
    if (!installer) return reply.code(404).send({ error: "installer not found" });
    const filePath = builder.filePath(installer);
    if (!fs.existsSync(filePath)) {
      return reply.code(410).send({ error: "installer file is missing; rebuild it" });
    }
    audit(store, req, "installer.downloaded", installer.filename);
    reply.header(
      "content-disposition",
      `attachment; filename="${installer.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
    );
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete("/api/installers/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const installer = store.getInstaller(id);
    if (!installer) return reply.code(404).send({ error: "installer not found" });
    builder.remove(id);
    audit(store, req, "installer.deleted", installer.filename);
    return reply.send({ ok: true });
  });

  app.get("/api/installers/defaults", { preHandler: requireAdmin }, async (req: FastifyRequest) => ({
    serverUrl: publicUrl || `${req.protocol}://${req.headers.host ?? "localhost"}`,
    installKey: store.getSetting("install_key") ?? "",
  }));
}
