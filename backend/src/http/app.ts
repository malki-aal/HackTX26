// Fastify HTTP adapter for the /api/v1 domain API.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { ZodError } from "zod";
import type { AppContext } from "../app/context.js";
import { AppError } from "../lib/errors.js";
import { scrub } from "../lib/redact.js";
import { createConfig, listConfigs, patchConfig } from "../services/agentConfigs.js";
import { clarifyRequest, confirmRequest, createRequest, getRequestView, listRequests, patchRequest } from "../services/requests.js";
import { cancelRun, getCandidates, getRunView, startResearch } from "../services/research.js";
import { listEvents } from "../services/events.js";
import { readFinancialContext } from "../services/budget.js";
import { createProposal, decideProposal, getProposalView, listProposals, submitProposal } from "../services/proposals.js";
import { getExecutionView, reconcileExecution } from "../services/executions.js";
import { integrationStatuses } from "../services/status.js";
import { sessionToolHosts } from "../agent/eveRunner.js";
import { CATEGORIES } from "../domain/categories.js";
import { CreateProjectBody } from "../contracts/domain.js";
import { confirmProjectLines, createProject, getProjectView, listProjects, researchProject } from "../services/projects.js";
import { createMapping, getMerchantDetails, listMappings, purchaseHistory } from "../services/merchants.js";
import { activity, confirmationRecord } from "../services/activity.js";
import DEMO_MANUFACTURING from "../../demo/manufacturing-desk-organizers.json" with { type: "json" };

export interface HttpOptions {
  internalToken: string;
}

export function buildApp(ctx: AppContext, opts: HttpOptions): FastifyInstance {
  const app = Fastify({
    logger: ctx.config.nodeEnv === "test" ? false : { level: "info", serializers: { req: (req) => ({ method: req.method, url: scrub(req.url) }) } },
    genReqId: () => `trace_${Math.random().toString(36).slice(2, 12)}`,
    bodyLimit: 256 * 1024,
  });

  void app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || ctx.config.frontendOrigins.includes(origin)),
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "idempotency-key"],
  });

  const meta = (req: FastifyRequest, extra: Record<string, unknown> = {}) => ({ mode: ctx.config.mode, demoIdentity: true as const, requestId: req.id, ...extra });
  const ok = (req: FastifyRequest, reply: FastifyReply, data: unknown, status = 200, extra: Record<string, unknown> = {}) => reply.status(status).send({ data, meta: meta(req, extra) });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(422).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", retryable: false, requestId: req.id, details: { issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } } });
    }
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: scrub(err.message), retryable: err.retryable, requestId: req.id, details: err.details } });
    }
    const fe = err as { statusCode?: number; code?: string; message?: string };
    if (fe.statusCode && fe.statusCode < 500) {
      return reply.status(fe.statusCode).send({ error: { code: "VALIDATION_ERROR", message: scrub(fe.message ?? "Bad request"), retryable: false, requestId: req.id, details: {} } });
    }
    req.log.error({ err: scrub(String(fe.message)) }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error", retryable: false, requestId: req.id, details: {} } });
  });
  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: "NOT_FOUND", message: `Route ${req.method} ${req.url.split("?")[0]} not found`, retryable: false, requestId: req.id, details: {} } }));

  const limitOf = (q: unknown, def = 50, max = 200) => {
    const n = Number((q as { limit?: string }).limit ?? def);
    return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
  };
  type P = { id: string };

  // ---- Health & status ----
  app.get("/api/v1/health", async (req, reply) => {
    ctx.db.prepare("SELECT 1").get();
    return ok(req, reply, { status: "ok", storage: "ok", time: ctx.now().toISOString() });
  });
  app.get("/api/v1/integrations/status", async (req, reply) => ok(req, reply, await integrationStatuses(ctx)));

  // ---- Agent configs ----
  app.get("/api/v1/agent-configs", async (req, reply) => ok(req, reply, listConfigs(ctx.db)));
  app.post("/api/v1/agent-configs", async (req, reply) => ok(req, reply, createConfig(ctx.db, req.body), 201));
  app.patch<{ Params: P }>("/api/v1/agent-configs/:id", async (req, reply) => ok(req, reply, patchConfig(ctx.db, req.params.id, req.body)));

  // ---- Requests ----
  app.post("/api/v1/requests", async (req, reply) => ok(req, reply, await createRequest(ctx, req.body), 201));
  app.get("/api/v1/requests", async (req, reply) => {
    const q = req.query as { cursor?: string; status?: string };
    const r = listRequests(ctx, { limit: limitOf(req.query, 20, 100), cursor: q.cursor ?? null, status: q.status });
    return ok(req, reply, r.items, 200, { nextCursor: r.nextCursor });
  });
  app.get<{ Params: P }>("/api/v1/requests/:id", async (req, reply) => ok(req, reply, getRequestView(ctx, req.params.id)));
  app.patch<{ Params: P }>("/api/v1/requests/:id", async (req, reply) => ok(req, reply, await patchRequest(ctx, req.params.id, req.body)));
  app.post<{ Params: P }>("/api/v1/requests/:id/clarify", async (req, reply) => ok(req, reply, clarifyRequest(ctx, req.params.id, req.body)));
  app.post<{ Params: P }>("/api/v1/requests/:id/confirm", async (req, reply) => ok(req, reply, confirmRequest(ctx, req.params.id, req.body)));
  app.post<{ Params: P }>("/api/v1/requests/:id/research", async (req, reply) => ok(req, reply, startResearch(ctx, req.params.id, req.body), 202));
  app.get<{ Params: P; Querystring: { runId?: string } }>("/api/v1/requests/:id/candidates", async (req, reply) => ok(req, reply, getCandidates(ctx, req.params.id, req.query.runId ?? null)));
  app.post<{ Params: P }>("/api/v1/requests/:id/proposals", async (req, reply) => ok(req, reply, createProposal(ctx, req.params.id, req.body as never), 201));

  // ---- Runs ----
  app.get<{ Params: P }>("/api/v1/runs/:id", async (req, reply) => ok(req, reply, getRunView(ctx, req.params.id)));
  app.get<{ Params: P; Querystring: { after?: string } }>("/api/v1/runs/:id/events", async (req, reply) => {
    getRunView(ctx, req.params.id);
    const r = listEvents(ctx.db, { runId: req.params.id }, req.query.after ?? null, limitOf(req.query, 100, 500));
    return ok(req, reply, r.events, 200, { nextCursor: r.nextCursor });
  });
  app.get<{ Params: P; Querystring: { after?: string } }>("/api/v1/requests/:id/events", async (req, reply) => {
    getRequestView(ctx, req.params.id);
    const r = listEvents(ctx.db, { requestId: req.params.id }, req.query.after ?? null, limitOf(req.query, 100, 500));
    return ok(req, reply, r.events, 200, { nextCursor: r.nextCursor });
  });
  app.post<{ Params: P }>("/api/v1/runs/:id/cancel", async (req, reply) => ok(req, reply, cancelRun(ctx, req.params.id)));

  // ---- Budget ----
  app.get<{ Querystring: { refresh?: string } }>("/api/v1/budget", async (req, reply) => {
    const r = await readFinancialContext(ctx, { refresh: req.query.refresh === "true" });
    return ok(req, reply, { ...r.context, fresh: r.fresh, error: r.error });
  });

  // ---- Proposals ----
  app.get<{ Querystring: { decisionState?: string } }>("/api/v1/proposals", async (req, reply) => ok(req, reply, listProposals(ctx, { decisionState: req.query.decisionState, limit: limitOf(req.query) })));
  app.get<{ Params: P }>("/api/v1/proposals/:id", async (req, reply) => {
    const p = getProposalView(ctx, req.params.id);
    return ok(req, reply, { ...p, execution: p.executionId ? getExecutionView(ctx, p.executionId) : null });
  });
  app.post<{ Params: P }>("/api/v1/proposals/:id/submit", async (req, reply) => ok(req, reply, submitProposal(ctx, req.params.id, req.body)));
  app.post<{ Params: P }>("/api/v1/proposals/:id/decision", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    const r = await decideProposal(ctx, req.params.id, req.body, Array.isArray(key) ? key[0] : key);
    return ok(req, reply, r.body, r.status);
  });

  // ---- Executions ----
  app.get<{ Params: P }>("/api/v1/executions/:id", async (req, reply) => ok(req, reply, getExecutionView(ctx, req.params.id)));
  app.post<{ Params: P }>("/api/v1/executions/:id/reconcile", async (req, reply) => ok(req, reply, await reconcileExecution(ctx, req.params.id, req.body)));

  // ---- Categories and demo input ----
  app.get("/api/v1/categories", async (req, reply) =>
    ok(
      req,
      reply,
      CATEGORIES.map((c) => ({ id: c.id, label: c.label, plural: c.plural, sector: c.sector, unit: c.unit, specs: c.specs, features: Object.entries(c.features).map(([id, f]) => ({ id, label: f.label })) })),
    ),
  );
  app.get("/api/v1/demo/manufacturing", async (req, reply) => ok(req, reply, { input: CreateProjectBody.parse(DEMO_MANUFACTURING), note: "Validated demo input. POST it to /api/v1/projects to create the project; nothing is created by this GET." }));

  // ---- Projects (multi-material lines) ----
  app.post("/api/v1/projects", async (req, reply) => ok(req, reply, await createProject(ctx, req.body), 201));
  app.get("/api/v1/projects", async (req, reply) => ok(req, reply, listProjects(ctx)));
  app.get<{ Params: P }>("/api/v1/projects/:id", async (req, reply) => ok(req, reply, getProjectView(ctx, req.params.id)));
  app.post<{ Params: P }>("/api/v1/projects/:id/confirm", async (req, reply) => ok(req, reply, confirmProjectLines(ctx, req.params.id)));
  app.post<{ Params: P }>("/api/v1/projects/:id/research", async (req, reply) => ok(req, reply, researchProject(ctx, req.params.id, req.body), 202));

  // ---- Merchants, mappings and purchase history ----
  app.get("/api/v1/merchant-mappings", async (req, reply) => ok(req, reply, listMappings(ctx)));
  app.post("/api/v1/merchant-mappings", async (req, reply) => ok(req, reply, await createMapping(ctx, req.body), 201));
  app.get<{ Params: P }>("/api/v1/merchants/:id", async (req, reply) => ok(req, reply, await getMerchantDetails(ctx, req.params.id)));
  app.get("/api/v1/purchase-history", async (req, reply) => ok(req, reply, await purchaseHistory(ctx)));

  // ---- Activity and confirmation records ----
  app.get("/api/v1/activity", async (req, reply) => ok(req, reply, activity(ctx, limitOf(req.query, 50, 200))));
  app.get<{ Params: P }>("/api/v1/proposals/:id/confirmation", async (req, reply) => ok(req, reply, confirmationRecord(ctx, req.params.id)));

  // ---- Internal: agent tool callbacks from the eve process (loopback + shared token only) ----
  const tokenBuf = Buffer.from(opts.internalToken);
  app.post<{ Params: { tool: string } }>("/internal/agent-tools/:tool", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    const given = Buffer.from(auth.replace(/^Bearer /, ""));
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
    if (!loopback || given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return reply.status(401).send({ error: "unauthorized" });
    const sessionId = String(req.headers["x-agent-session-id"] ?? "");
    const host = sessionToolHosts.get(sessionId);
    if (!host) return reply.status(409).send({ error: "No active research run for this agent session. Context was lost (for example after a restart)." });
    try {
      return reply.send({ result: await host.call(req.params.tool, req.body ?? {}) });
    } catch (e) {
      const msg = e instanceof ZodError ? `Invalid tool input: ${e.issues.map((i) => i.message).join("; ")}` : e instanceof AppError ? `${e.code}: ${e.message}` : "Tool failed";
      return reply.status(200).send({ error: scrub(msg) });
    }
  });

  return app;
}
