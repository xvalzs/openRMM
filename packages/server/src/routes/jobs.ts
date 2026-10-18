/**
 * Job management endpoints.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { FastifyInstance } from "fastify";
import type { JobCreateInput, JobDetail } from "@openrmm/shared";
import type { Store } from "../db.js";
import type { JobsService } from "../jobs.js";
import { requireSession } from "./auth.js";

function parseJobBody(body: unknown): JobCreateInput | { error: string } {
  const b = (body ?? {}) as Partial<JobCreateInput>;
  if (typeof b.name !== "string" || !b.name.trim()) return { error: "name is required" };
  if (typeof b.script !== "string" || !b.script.trim()) {
    return { error: "script is required" };
  }
  if (
    b.deviceIds !== undefined &&
    b.deviceIds !== null &&
    (!Array.isArray(b.deviceIds) || b.deviceIds.some((d) => typeof d !== "string"))
  ) {
    return { error: "deviceIds must be an array of strings or null" };
  }
  return {
    name: b.name.trim(),
    script: b.script,
    deviceIds: b.deviceIds ?? null,
    timeoutSec: b.timeoutSec,
  };
}

export function registerJobRoutes(
  app: FastifyInstance,
  store: Store,
  jobs: JobsService,
): void {
  app.post("/api/jobs", { preHandler: requireSession }, async (req, reply) => {
    const parsed = parseJobBody(req.body);
    if ("error" in parsed) return reply.code(400).send({ error: parsed.error });
    const job = jobs.dispatch(parsed, req.session!.username);
    return reply.code(201).send(job);
  });

  app.get("/api/jobs", { preHandler: requireSession }, async () => ({
    jobs: store.listJobs(),
  }));

  app.get("/api/jobs/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = store.getJob(id);
    if (!job) return reply.code(404).send({ error: "job not found" });
    const body: JobDetail = { job, results: store.getJobResults(id) };
    return body;
  });

  app.post("/api/jobs/:id/cancel", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!jobs.cancel(id)) return reply.code(404).send({ error: "job not found" });
    return reply.send({ ok: true });
  });

  app.delete("/api/jobs/:id", { preHandler: requireSession }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!store.deleteJob(id)) return reply.code(404).send({ error: "job not found" });
    return reply.send({ ok: true });
  });
}
