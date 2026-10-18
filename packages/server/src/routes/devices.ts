/**
 * Dashboard-facing device endpoints. All require a valid session.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { DeviceListResponse } from "@openrmm/shared";
import type { Store } from "../db.js";
import { requireSession } from "./auth.js";

export function registerDeviceRoutes(app: FastifyInstance, store: Store): void {
  app.get("/api/devices", { preHandler: requireSession }, async () => {
    const devices = store.listDevices();
    const body: DeviceListResponse = {
      devices,
      summary: {
        total: devices.length,
        online: devices.filter((d) => d.online).length,
      },
    };
    return body;
  });

  app.get("/api/devices/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const device = store.getDevice(id);
    if (!device) return reply.code(404).send({ error: "device not found" });
    return device;
  });
}
