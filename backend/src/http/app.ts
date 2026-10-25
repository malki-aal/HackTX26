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
import { createProposal, decideProposal, financialPreview, getProposalView, listProposals, submitProposal } from "../services/proposals.js";
import { getExecutionView, reconcileExecution } from "../services/executions.js";
import { integrationStatuses } from "../services/status.js";
import { sessionToolHosts } from "../agent/eveRunner.js";
import { CATEGORIES, getCategory } from "../domain/categories.js";
import { CreateProjectBody, ScenarioPresets } from "../contracts/domain.js";
import { confirmProjectLines, createProject, getProjectView, listProjects, researchProject } from "../services/projects.js";
import { createMapping, getMerchantDetails, listMappings, purchaseHistory } from "../services/merchants.js";
import { activity, confirmationRecord } from "../services/activity.js";
import DEMO_MANUFACTURING from "../../demo/manufacturing-desk-organizers.json" with { type: "json" };
import DEMO_SCENARIOS from "../../demo/scenarios.json" with { type: "json" };
import { currentUserView, patchMe, requireExecutive, requireMember, resolvePrincipal, type Principal } from "../auth/access.js";
import { accountAccess, executionAccess, projectAccess, proposalAccess, requestAccess, runAccess } from "../auth/scope.js";

/** The demo `actor` field was already used to resolve the principal; services never see it. */
function stripActor(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const { actor: _a, ...rest } = body as Record<string, unknown>;
  return rest;
}

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
    // authorization carries the Clerk session token; x-demo-actor is honored only in fixtures demo mode.
    allowedHeaders: ["content-type", "idempotency-key", "authorization", "x-demo-actor"],
  });

  const demo = ctx.config.auth.mode === "demo";
  const meta = (req: FastifyRequest, extra: Record<string, unknown> = {}) => ({ mode: ctx.config.mode, authMode: ctx.config.auth.mode, demoIdentity: demo, requestId: req.id, ...extra });
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

  /** The verified caller. Every protected route calls this first; nothing is trusted from the body. */
  const who = (req: FastifyRequest): Promise<Principal> => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const h = req.headers["x-demo-actor"];
    return resolvePrincipal(ctx, {
      authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
      demoActorHeader: Array.isArray(h) ? h[0] : h,
      bodyActor: body.actor,
    });
  };
  const member = async (req: FastifyRequest) => {
    const p = await who(req);
    requireMember(p);
    return p;
  };
  const executive = async (req: FastifyRequest) => {
    const p = await who(req);
    requireExecutive(p);
    return p;
  };

  // ---- Public ----
  app.get("/api/v1/health", async (req, reply) => {
    ctx.db.prepare("SELECT 1").get();
    return ok(req, reply, { status: "ok", storage: "ok", time: ctx.now().toISOString(), auth: { mode: ctx.config.auth.mode, configured: demo || !!ctx.identity } });
  });
  app.get("/api/v1/categories", async (req, reply) =>
    ok(
      req,
      reply,
      CATEGORIES.map((c) => ({ id: c.id, label: c.label, plural: c.plural, sector: c.sector, selectable: c.selectable, unit: c.unit, specs: c.specs, features: Object.entries(c.features).map(([id, f]) => ({ id, label: f.label })) })),
    ),
  );
  // Example presets for the New Request form. Public, read-only, and they never create or research anything.
  const scenarios = ScenarioPresets.parse(DEMO_SCENARIOS);
  for (const sc of scenarios.scenarios) {
    if (!getCategory(sc.categoryId)?.selectable) throw new Error(`Scenario ${sc.id} uses a category that new requests cannot use`);
  }
  app.get("/api/v1/demo/scenarios", async (req, reply) => ok(req, reply, scenarios));
  app.get("/api/v1/demo/manufacturing", async (req, reply) => ok(req, reply, { input: CreateProjectBody.parse(DEMO_MANUFACTURING), note: "Validated demo input. POST it to /api/v1/projects to create the project; nothing is created by this GET." }));

  // ---- Current user (signed in; works before access is granted) ----
  app.get("/api/v1/me", async (req, reply) => ok(req, reply, currentUserView(ctx, await who(req))));
  app.patch("/api/v1/me", async (req, reply) => ok(req, reply, patchMe(ctx, await who(req), req.body)));

  // ---- Status and agent configs ----
  app.get("/api/v1/integrations/status", async (req, reply) => {
    await member(req);
    return ok(req, reply, await integrationStatuses(ctx));
  });
  app.get("/api/v1/agent-configs", async (req, reply) => {
    await member(req);
    return ok(req, reply, listConfigs(ctx.db));
  });
  app.post("/api/v1/agent-configs", async (req, reply) => {
    await executive(req);
    return ok(req, reply, createConfig(ctx.db, req.body), 201);
  });
  app.patch<{ Params: P }>("/api/v1/agent-configs/:id", async (req, reply) => {
    await executive(req);
    return ok(req, reply, patchConfig(ctx.db, req.params.id, req.body));
  });

  // ---- Requests (employees: their own; executives: read their company's) ----
  app.post("/api/v1/requests", async (req, reply) => {
    const p = await member(req);
    return ok(req, reply, await createRequest(ctx, stripActor(req.body), p.userId, { orgId: p.orgId }), 201);
  });
  app.get("/api/v1/requests", async (req, reply) => {
    const p = await member(req);
    const q = req.query as { cursor?: string; status?: string };
    const r = listRequests(ctx, { limit: limitOf(req.query, 20, 100), cursor: q.cursor ?? null, status: q.status, orgId: p.orgId, ownerId: p.role === "executive" ? undefined : p.userId });
    return ok(req, reply, r.items, 200, { nextCursor: r.nextCursor });
  });
  app.get<{ Params: P }>("/api/v1/requests/:id", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, getRequestView(ctx, req.params.id));
  });
  app.patch<{ Params: P }>("/api/v1/requests/:id", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, await patchRequest(ctx, req.params.id, req.body));
  });
  app.post<{ Params: P }>("/api/v1/requests/:id/clarify", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, clarifyRequest(ctx, req.params.id, req.body));
  });
  app.post<{ Params: P }>("/api/v1/requests/:id/confirm", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, confirmRequest(ctx, req.params.id, req.body));
  });
  app.post<{ Params: P }>("/api/v1/requests/:id/research", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, startResearch(ctx, req.params.id, req.body), 202);
  });
  app.get<{ Params: P; Querystring: { runId?: string } }>("/api/v1/requests/:id/candidates", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, getCandidates(ctx, req.params.id, req.query.runId ?? null));
  });
  app.post<{ Params: P }>("/api/v1/requests/:id/proposals", async (req, reply) => {
    const p = await member(req);
    requestAccess(ctx, p, req.params.id, "write");
    return ok(req, reply, createProposal(ctx, req.params.id, stripActor(req.body) as never, p.userId), 201);
  });
  app.get<{ Params: P; Querystring: { after?: string } }>("/api/v1/requests/:id/events", async (req, reply) => {
    requestAccess(ctx, await member(req), req.params.id, "read");
    const r = listEvents(ctx.db, { requestId: req.params.id }, req.query.after ?? null, limitOf(req.query, 100, 500));
    return ok(req, reply, r.events, 200, { nextCursor: r.nextCursor });
  });

  // ---- Runs ----
  app.get<{ Params: P }>("/api/v1/runs/:id", async (req, reply) => {
    runAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, getRunView(ctx, req.params.id));
  });
  app.get<{ Params: P; Querystring: { after?: string } }>("/api/v1/runs/:id/events", async (req, reply) => {
    runAccess(ctx, await member(req), req.params.id, "read");
    const r = listEvents(ctx.db, { runId: req.params.id }, req.query.after ?? null, limitOf(req.query, 100, 500));
    return ok(req, reply, r.events, 200, { nextCursor: r.nextCursor });
  });
  app.post<{ Params: P }>("/api/v1/runs/:id/cancel", async (req, reply) => {
    runAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, cancelRun(ctx, req.params.id));
  });

  // ---- Budget: executives of the account's company; employees get status only ----
  app.get<{ Querystring: { refresh?: string } }>("/api/v1/budget", async (req, reply) => {
    const p = await member(req);
    const fullAccess = p.role === "executive" && p.orgId === ctx.config.auth.accountCompanyId;
    const r = await readFinancialContext(ctx, { refresh: fullAccess && req.query.refresh === "true" });
    if (fullAccess) return ok(req, reply, { ...r.context, fresh: r.fresh, error: r.error, scope: "executive" });
    return ok(req, reply, {
      scope: "employee",
      status: r.context.status,
      source: r.context.source,
      fetchedAt: r.context.fetchedAt,
      reportedBalanceCents: null,
      obligations: [],
      obligationsCents: 0,
      activeReservationsCents: 0,
      unreflectedExpensesCents: 0,
      availableBudgetCents: null,
      reconciliationNotes: ["Company account figures are visible to executives."],
      fresh: false,
      error: null,
    });
  });

  // ---- Proposals ----
  app.get<{ Querystring: { decisionState?: string; cursor?: string; updatedAfter?: string } }>("/api/v1/proposals", async (req, reply) => {
    const p = await member(req);
    const r = listProposals(ctx, p, { decisionState: req.query.decisionState, limit: limitOf(req.query, 20, 100), cursor: req.query.cursor ?? null, updatedAfter: req.query.updatedAfter ?? null });
    return ok(req, reply, r.items, 200, { nextCursor: r.nextCursor, counts: r.counts, serverTime: r.serverTime });
  });
  app.get<{ Params: P }>("/api/v1/proposals/:id", async (req, reply) => {
    const p = await member(req);
    proposalAccess(ctx, p, req.params.id, "read");
    const v = getProposalView(ctx, req.params.id, p);
    const financialAssessment = p.role === "executive" ? await financialPreview(ctx, req.params.id, { refresh: false }) : null;
    return ok(req, reply, { ...v, financialAssessment, execution: v.executionId ? getExecutionView(ctx, v.executionId) : null });
  });
  app.get<{ Params: P; Querystring: { refresh?: string } }>("/api/v1/proposals/:id/financial-preview", async (req, reply) => {
    const p = await executive(req);
    proposalAccess(ctx, p, req.params.id, "read");
    return ok(req, reply, await financialPreview(ctx, req.params.id, { refresh: req.query.refresh === "true" }));
  });
  app.post<{ Params: P }>("/api/v1/proposals/:id/submit", async (req, reply) => {
    proposalAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, submitProposal(ctx, req.params.id, stripActor(req.body)));
  });
  app.post<{ Params: P }>("/api/v1/proposals/:id/decision", async (req, reply) => {
    const p = await who(req);
    const key = req.headers["idempotency-key"];
    const r = await decideProposal(ctx, req.params.id, req.body, Array.isArray(key) ? key[0] : key, p);
    return ok(req, reply, r.body, r.status);
  });
  app.get<{ Params: P }>("/api/v1/proposals/:id/confirmation", async (req, reply) => {
    proposalAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, confirmationRecord(ctx, req.params.id));
  });

  // ---- Executions ----
  app.get<{ Params: P }>("/api/v1/executions/:id", async (req, reply) => {
    executionAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, getExecutionView(ctx, req.params.id));
  });
  app.post<{ Params: P }>("/api/v1/executions/:id/reconcile", async (req, reply) => {
    const p = await member(req);
    executionAccess(ctx, p, req.params.id, "reconcile");
    return ok(req, reply, await reconcileExecution(ctx, req.params.id, stripActor(req.body), p.userId));
  });

  // ---- Projects (multi-material lines) ----
  app.post("/api/v1/projects", async (req, reply) => {
    const p = await member(req);
    return ok(req, reply, await createProject(ctx, stripActor(req.body), p.userId, p.orgId), 201);
  });
  app.get("/api/v1/projects", async (req, reply) => {
    const p = await member(req);
    return ok(req, reply, listProjects(ctx, { orgId: p.orgId, ownerId: p.role === "executive" ? undefined : p.userId }));
  });
  app.get<{ Params: P }>("/api/v1/projects/:id", async (req, reply) => {
    projectAccess(ctx, await member(req), req.params.id, "read");
    return ok(req, reply, getProjectView(ctx, req.params.id));
  });
  app.post<{ Params: P }>("/api/v1/projects/:id/confirm", async (req, reply) => {
    projectAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, confirmProjectLines(ctx, req.params.id));
  });
  app.post<{ Params: P }>("/api/v1/projects/:id/research", async (req, reply) => {
    projectAccess(ctx, await member(req), req.params.id, "write");
    return ok(req, reply, researchProject(ctx, req.params.id, req.body), 202);
  });

  // ---- Merchants, mappings and purchase history (executives of the account company) ----
  app.get("/api/v1/merchant-mappings", async (req, reply) => {
    accountAccess(ctx, await who(req));
    return ok(req, reply, listMappings(ctx));
  });
  app.post("/api/v1/merchant-mappings", async (req, reply) => {
    const p = await who(req);
    accountAccess(ctx, p);
    return ok(req, reply, await createMapping(ctx, req.body, p), 201);
  });
  app.get<{ Params: P }>("/api/v1/merchants/:id", async (req, reply) => {
    accountAccess(ctx, await who(req));
    return ok(req, reply, await getMerchantDetails(ctx, req.params.id));
  });
  app.get("/api/v1/purchase-history", async (req, reply) => {
    accountAccess(ctx, await who(req));
    return ok(req, reply, await purchaseHistory(ctx));
  });

  // ---- Activity ----
  app.get("/api/v1/activity", async (req, reply) => ok(req, reply, activity(ctx, await member(req), limitOf(req.query, 50, 200))));

  // ---- Internal: agent tool callbacks from the eve process (loopback + shared token only) ----
  const tokenBuf = Buffer.from(opts.internalToken);
  // The agent process reports real model-quota pauses (its pacing has no session context, so the
  // wait is recorded on every active agent run; normally there is one).
  app.post<{ Body: { waitMs?: unknown } }>("/internal/agent-progress", async (req, reply) => {
    const auth = String(req.headers.authorization ?? "");
    const given = Buffer.from(auth.replace(/^Bearer /, ""));
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
    if (!loopback || given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) return reply.status(401).send({ error: "unauthorized" });
    const waitMs = Number(req.body?.waitMs);
    if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > 600_000) return reply.status(400).send({ error: "waitMs must be a positive number of milliseconds" });
    for (const host of sessionToolHosts.values()) host.quotaWait?.(waitMs);
    return reply.send({ ok: true });
  });

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
