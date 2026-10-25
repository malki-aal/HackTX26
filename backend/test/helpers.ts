import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type AppConfig } from "../src/config.js";
import { createContext } from "../src/app/bootstrap.js";
import { buildApp } from "../src/http/app.js";
import { FixtureBank, FixtureExtractor, FixtureShopping } from "../src/integrations/fixtures.js";
import { ScriptedAgentRunner, type AgentRunner } from "../src/agent/runner.js";
import { awaitRun } from "../src/services/research.js";
import type { AppContext } from "../src/app/context.js";
import type { FastifyInstance } from "fastify";
import type { IdentityProvider } from "../src/auth/identity.js";

export const FAKE_SECRET = "sk_test_SUPERSECRET_should_never_leak_123";

export function testConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), "runway-test-"));
  return parseConfig({ NODE_ENV: "test", INTEGRATION_MODE: "fixtures", DATABASE_PATH: join(dir, "t.sqlite"), SERPAPI_API_KEY: FAKE_SECRET, ...overrides });
}

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  shopping: FixtureShopping;
  bank: FixtureBank;
  clock: { now: Date };
  call: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
}

/** Demo-mode executive identity (fixtures only); signed-in mode ignores nothing and rejects this header. */
export const EXEC = { "x-demo-actor": "executive-demo" };

export function harness(opts: { config?: AppConfig; shopping?: FixtureShopping; bank?: FixtureBank; runner?: AgentRunner; identity?: IdentityProvider | null } = {}): Harness {
  const config = opts.config ?? testConfig();
  const shopping = opts.shopping ?? new FixtureShopping();
  const bank = opts.bank ?? new FixtureBank();
  const clock = { now: new Date() };
  const ctx = createContext(config, { adapters: { shopping, bank, extractor: new FixtureExtractor() }, agentRunner: opts.runner ?? new ScriptedAgentRunner(), now: () => clock.now, ...(opts.identity !== undefined ? { identity: opts.identity } : {}) });
  const app = buildApp(ctx, { internalToken: "t".repeat(64) });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as never, url, payload: body as never, headers });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { ctx, app, shopping, bank, clock, call };
}

export const MONITOR_REQUEST = {
  title: "Four engineering monitors",
  description: "Find four new 27-inch monitors, at least 1440p, HDMI required.",
  category: "monitors",
  quantity: 4,
  currency: "USD",
  budgetCents: 100000,
  budgetBasis: "total",
  allowedCondition: "new",
  rankingPriority: "lowest_known_total",
};

/** Create, confirm and research a request; returns ids and the top candidate. */
export async function researched(h: Harness, overrides: Record<string, unknown> = {}, research: Record<string, unknown> = {}) {
  const created = await h.call("POST", "/api/v1/requests", { ...MONITOR_REQUEST, ...overrides });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.data.id;
  let version = created.body.data.version;
  const unanswered: string[] = created.body.data.unansweredQuestionIds;
  if (unanswered.length) {
    const answers = created.body.data.questions.filter((q: any) => q.answer === null).map((q: any) => ({ questionId: q.id, value: q.options[0]?.value ?? "ok" }));
    const c = await h.call("POST", `/api/v1/requests/${id}/clarify`, { expectedVersion: version, answers });
    version = c.body.data.version;
  }
  const conf = await h.call("POST", `/api/v1/requests/${id}/confirm`, { version });
  if (conf.status !== 200) throw new Error(JSON.stringify(conf.body));
  const start = await h.call("POST", `/api/v1/requests/${id}/research`, { version, ...research });
  if (start.status !== 202) throw new Error(JSON.stringify(start.body));
  const runId = start.body.data.runId;
  await awaitRun(runId);
  const cands = await h.call("GET", `/api/v1/requests/${id}/candidates?runId=${runId}`);
  return { id, version, runId, candidates: cands.body.data.candidates as any[], run: (await h.call("GET", `/api/v1/runs/${runId}`)).body.data };
}

export async function submittedProposal(h: Harness, exactAmountCents?: number, overrides: Record<string, unknown> = {}) {
  const r = await researched(h, overrides);
  const top = r.candidates.find((c) => c.eligibility === "eligible");
  if (!top) throw new Error("no eligible candidate");
  const p = await h.call("POST", `/api/v1/requests/${r.id}/proposals`, { runId: r.runId, offerId: top.offerId, justification: "Cheapest eligible" });
  if (p.status !== 201) throw new Error(JSON.stringify(p.body));
  const amount = exactAmountCents ?? top.knownComparableCostCents + 5000;
  const s = await h.call("POST", `/api/v1/proposals/${p.body.data.id}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: amount });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  return { ...r, proposalId: p.body.data.id as string, amount, top };
}

/** Explicitly map the proposal's researched seller to a sandbox merchant (no-op if already mapped). */
export async function mapSeller(h: Harness, proposalId: string) {
  const p = await h.call("GET", `/api/v1/proposals/${proposalId}`);
  const seller = p.body.data.offer.seller;
  const existing = await h.call("GET", "/api/v1/merchant-mappings", undefined, EXEC);
  if (existing.body.data.some((m: any) => m.seller === seller)) return;
  const r = await h.call("POST", "/api/v1/merchant-mappings", { action: "create_sandbox_merchant", seller, actor: "executive-demo" });
  if (r.status !== 201 && !(r.status === 409 && /already mapped/.test(r.body.error?.message ?? ""))) throw new Error(JSON.stringify(r.body));
}

/** Approve (mapping the seller first unless `map` is false), confirming the exact version and amount. */
export const approve = async (h: Harness, proposalId: string, key = `key-${Math.random().toString(36).slice(2)}`, decision = "approve", version = 1, map = true) => {
  if (map && decision === "approve") await mapSeller(h, proposalId);
  const p = await h.call("GET", `/api/v1/proposals/${proposalId}`, undefined, EXEC);
  const amount = p.body.data?.amounts?.exactAmountCents;
  const confirmation = decision === "approve" && amount ? { confirmation: { confirmed: true, proposalVersion: version, exactAmountCents: amount } } : {};
  return h.call("POST", `/api/v1/proposals/${proposalId}/decision`, { version, decision, actor: "executive-demo", ...confirmation }, { "idempotency-key": key });
};
