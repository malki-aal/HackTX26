import { describe, expect, it } from "vitest";
import { approve, FAKE_SECRET, harness, MONITOR_REQUEST, researched, submittedProposal, testConfig, EXEC } from "./helpers.js";
import { FixtureBank, FixtureShopping } from "../src/integrations/fixtures.js";
import { IntegrationError } from "../src/lib/errors.js";
import { createContext, buildAdapters } from "../src/app/bootstrap.js";
import { FixtureExtractor } from "../src/integrations/fixtures.js";
import { ScriptedAgentRunner } from "../src/agent/runner.js";
import { awaitRun } from "../src/services/research.js";
import { parseShoppingResponse } from "../src/integrations/serpapi.js";
import { registerSecrets } from "../src/lib/redact.js";

describe("end-to-end flow", () => {
  it("clarification -> confirmation -> research -> proposal -> approval -> sandbox execution", async () => {
    const h = harness();
    const created = await h.call("POST", "/api/v1/requests", { ...MONITOR_REQUEST, description: "Find four new 27-inch monitors, at least 1440p, with HDMI." , budgetBasis: undefined });
    expect(created.status).toBe(201);
    expect(created.body.meta.demoIdentity).toBe(true);
    expect(created.body.data.status).toBe("needs_clarification");
    const qids = created.body.data.unansweredQuestionIds;
    expect(qids).toEqual(expect.arrayContaining(["q_budget_basis", "q_mandatory_req_port_hdmi"]));

    const r = await researched(h);
    expect(r.run.status).toBe("completed");
    expect(r.run.outcome).toBe("candidates_found");
    expect(r.run.searches.length).toBe(2); // cfg_default allows 2 searches
    expect(r.candidates[0].eligibility).toBe("eligible");
    expect(r.candidates[0].requirementChecks.every((c: any) => c.mandatory === false || c.state === "supported")).toBe(true);

    const p = await submittedProposal(h);
    const res = await approve(h, p.proposalId, "approve-key-0001");
    expect(res.status).toBe(200);
    expect(res.body.data.decisionState).toBe("approved");
    expect(res.body.data.execution.status).toBe("recorded");
    expect(res.body.data.execution.externalReference.purchaseId).toMatch(/^fixture_purchase_/);
    expect(h.bank.createCalls).toBe(1);
    expect(h.bank.state.purchases[0]!.amountCents).toBe(p.amount);

    const events = await h.call("GET", `/api/v1/requests/${p.id}/events`);
    const types = events.body.data.map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["requirements_confirmed", "research_started", "search_completed", "evaluation_completed", "research_completed", "proposal_submitted", "decision_recorded", "execution_queued", "execution_submitting", "execution_recorded"]));
  });

  it("refuses research before confirmation and decisions before submission", async () => {
    const h = harness();
    const c = await h.call("POST", "/api/v1/requests", MONITOR_REQUEST);
    const r = await h.call("POST", `/api/v1/requests/${c.body.data.id}/research`, { version: c.body.data.version });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("REQUIREMENTS_UNCONFIRMED");
    expect(h.shopping.calls.length).toBe(0);

    const rr = await researched(h);
    const p = await h.call("POST", `/api/v1/requests/${rr.id}/proposals`, { runId: rr.runId, offerId: rr.candidates[0].offerId });
    const d = await approve(h, p.body.data.id);
    expect(d.status).toBe(409);
    expect(d.body.error.code).toBe("INVALID_STATE");
    expect(h.bank.createCalls).toBe(0);
  });

  it("validates input types and amounts", async () => {
    const h = harness();
    for (const bad of [{ quantity: "4" }, { budgetCents: -1 }, { budgetCents: 12.5 }, { currency: "EUR" }, { quantity: 0 }]) {
      const r = await h.call("POST", "/api/v1/requests", { ...MONITOR_REQUEST, ...bad });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("agent configuration", () => {
  it("configuration limits and enabled tools change behavior", async () => {
    const h = harness();
    const cfg = await h.call("POST", "/api/v1/agent-configs", {
      id: "cfg_one_search",
      displayName: "One search, no bank",
      instructions: "Be brief.",
      enabledTools: ["getConfirmedRequirements", "searchProducts", "evaluateCandidates", "prepareProposalDraft"],
      rankingPriority: "lowest_known_total",
      searchStrategy: "exact_specs",
      limits: { maxSearchCalls: 1, maxSteps: 8, maxDurationMs: 60000 },
    }, EXEC);
    expect(cfg.status).toBe(201);
    const r = await researched(h, {}, { agentConfigId: "cfg_one_search" });
    expect(h.shopping.calls.length).toBe(1);
    expect(r.run.agentConfig).toMatchObject({ id: "cfg_one_search", version: 1 });
    const ev = await h.call("GET", `/api/v1/runs/${r.runId}/events`);
    expect(ev.body.data.some((e: any) => e.type === "budget_checked")).toBe(false);

    const patched = await h.call("PATCH", "/api/v1/agent-configs/cfg_one_search", { expectedVersion: 1, limits: { maxSearchCalls: 3, maxSteps: 8, maxDurationMs: 60000 } }, EXEC);
    expect(patched.body.data.version).toBe(2);
    const stale = await h.call("PATCH", "/api/v1/agent-configs/cfg_one_search", { expectedVersion: 1, displayName: "x" }, EXEC);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    // The environment cap (3) still applies.
    const big = await h.call("PATCH", "/api/v1/agent-configs/cfg_one_search", { expectedVersion: 2, limits: { maxSearchCalls: 50, maxSteps: 8, maxDurationMs: 60000 } }, EXEC);
    expect(big.status).toBe(422);
    const tool = await h.call("POST", "/api/v1/agent-configs", { displayName: "bad", instructions: "", enabledTools: ["executePurchase"], rankingPriority: "lowest_known_total", searchStrategy: "exact_specs", limits: { maxSearchCalls: 1, maxSteps: 4, maxDurationMs: 60000 } }, EXEC);
    expect(tool.status).toBe(422);
  });

  it("step limit stops the agent", async () => {
    const h = harness();
    await h.call("POST", "/api/v1/agent-configs", { id: "cfg_tiny", displayName: "Tiny", instructions: "", enabledTools: ["getConfirmedRequirements", "searchProducts", "evaluateCandidates", "prepareProposalDraft"], rankingPriority: "lowest_known_total", searchStrategy: "exact_specs", limits: { maxSearchCalls: 3, maxSteps: 2, maxDurationMs: 60000 } }, EXEC);
    const r = await researched(h, {}, { agentConfigId: "cfg_tiny" });
    expect(h.shopping.calls.length).toBe(1);
    expect(r.run.agentSummary.runtime.stopReason).toBe("step_limit");
  });
});

describe("product-detail evidence", () => {
  it("details resolve unconfirmed specs, conflicts stay unknown, and the cap is enforced", async () => {
    const h = harness();
    const r = await researched(h);
    expect(r.run.limits.detailCallsUsed).toBe(2);
    expect(h.shopping.detailCalls.sort()).toEqual(["tok_fx11", "tok_fx5"]);
    const corvo = r.candidates.find((c) => c.title.includes("Corvo"));
    expect(corvo.eligibility).toBe("eligible");
    expect(corvo.requirementChecks.find((c: any) => c.attribute === "port").reason).toMatch(/Product specs/);
    expect(corvo.shippingCents).toBe(0);
    const delta = r.candidates.find((c) => c.title.includes("Delta"));
    const res = delta.requirementChecks.find((c: any) => c.attribute === "resolution");
    expect(res.state).toBe("unknown");
    expect(res.reason).toMatch(/Conflicting evidence/);
    expect(delta.eligibility).toBe("needs_review");
    // Tokens never leave the server.
    expect(JSON.stringify(r.candidates)).not.toContain("tok_fx");
  });
});

describe("integration failures", () => {
  it("search quota errors fail the run with a stable code", async () => {
    const h = harness({ shopping: new FixtureShopping(undefined, { failWith: new IntegrationError("serpapi", "UPSTREAM_RATE_LIMITED", "SerpApi rate limited", "definitive", false, 429) }) });
    const r = await researched(h);
    expect(r.run.status).toBe("failed");
    expect(r.run.error.code).toBe("UPSTREAM_RATE_LIMITED");
  });
  it("malformed provider data is rejected and empty results are not errors", () => {
    expect(() => parseShoppingResponse({ shopping_results: "nope" })).toThrow();
    expect(parseShoppingResponse({ search_metadata: { status: "Success" }, error: "Google hasn't returned any results for this query." }).outcome).toBe("empty");
    expect(parseShoppingResponse({ shopping_results: [{ title: "ok" }, { notitle: 1 }] }).dropped).toBe(1);
  });
  it("no results is a completed run", async () => {
    const h = harness({ shopping: new FixtureShopping([]) });
    const r = await researched(h);
    expect(r.run.status).toBe("completed");
    expect(r.run.outcome).toBe("no_results");
  });
  it("no confirmed match is a completed run outcome", async () => {
    const h = harness();
    const r = await researched(h, { budgetCents: 30000 });
    expect(r.run.status).toBe("completed");
    expect(r.run.outcome).toBe("no_confirmed_match");
  });
  it("cancellation stops future work and preserves completed evidence", async () => {
    const h = harness({ shopping: new FixtureShopping(undefined, { delayMs: 200 }) });
    const c = await h.call("POST", "/api/v1/requests", { ...MONITOR_REQUEST });
    const id = c.body.data.id;
    await h.call("POST", `/api/v1/requests/${id}/confirm`, { version: 1 });
    const s = await h.call("POST", `/api/v1/requests/${id}/research`, { version: 1 });
    const runId = s.body.data.runId;
    const again = await h.call("POST", `/api/v1/requests/${id}/research`, { version: 1 });
    expect(again.body.error.code).toBe("RUN_ALREADY_ACTIVE");
    await h.call("POST", `/api/v1/runs/${runId}/cancel`);
    await awaitRun(runId);
    const run = await h.call("GET", `/api/v1/runs/${runId}`);
    expect(run.body.data.status).toBe("cancelled");
  });
});

describe("safety boundaries", () => {
  it("search prompt injection cannot expose keys or trigger execution", async () => {
    registerSecrets([FAKE_SECRET]);
    const h = harness();
    const r = await researched(h);
    const nova = r.candidates.find((c) => c.title.includes("Nova"));
    expect(nova.eligibility).toBe("needs_review");
    expect(nova.unknowns.join(" ")).toMatch(/instruction-like/);
    expect(h.bank.createCalls).toBe(0);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM executions").get()).toEqual({ n: 0 });
    const all = JSON.stringify([
      (await h.call("GET", `/api/v1/runs/${r.runId}/events`)).body,
      (await h.call("GET", `/api/v1/requests/${r.id}/candidates`)).body,
      (await h.call("GET", "/api/v1/integrations/status")).body,
      h.ctx.db.prepare("SELECT * FROM events").all(),
    ]);
    expect(all).not.toContain(FAKE_SECRET);
  });

  it("agent tools reject disabled tools and invalid inputs at the server", async () => {
    const h = harness();
    const r = await researched(h);
    // Internal route is not reachable without the token.
    const res = await h.app.inject({ method: "POST", url: "/internal/agent-tools/searchProducts", payload: {}, remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(401);
    const res2 = await h.app.inject({ method: "POST", url: "/internal/agent-tools/searchProducts", payload: {}, remoteAddress: "10.0.0.5", headers: { authorization: `Bearer ${"t".repeat(64)}` } });
    expect(res2.statusCode).toBe(401);
    expect(r.run.status).toBe("completed");
  });

  it("fixture mode never constructs a live bank adapter and cannot execute a fixture proposal live", async () => {
    expect(buildAdapters(testConfig()).bank.source).toBe("fixture");
    const h = harness();
    const p = await submittedProposal(h);
    (h.ctx.config as { mode: string }).mode = "live";
    const d = await approve(h, p.proposalId);
    expect(d.body.error.code).toBe("MODE_MISMATCH");
    expect(h.bank.createCalls).toBe(0);
  });
});

describe("proposals and decisions", () => {
  it("rejected candidates cannot be proposed", async () => {
    const h = harness();
    const r = await researched(h);
    const rejected = r.candidates.find((c) => c.eligibility === "rejected");
    const p = await h.call("POST", `/api/v1/requests/${r.id}/proposals`, { runId: r.runId, offerId: rejected.offerId });
    expect(p.status).toBe(422);
  });

  it("stale offers require review", async () => {
    const h = harness();
    const p = await submittedProposal(h);
    h.clock.now = new Date(Date.now() + 31 * 60_000);
    const d = await approve(h, p.proposalId);
    expect(d.body.error.code).toBe("OFFER_STALE");
    expect(h.bank.createCalls).toBe(0);
  });

  it("editing requirements after submission invalidates the proposal", async () => {
    const h = harness();
    const p = await submittedProposal(h);
    const req = await h.call("GET", `/api/v1/requests/${p.id}`);
    // Submitted requests are locked; change requests go through request_changes.
    const patch = await h.call("PATCH", `/api/v1/requests/${p.id}`, { expectedVersion: req.body.data.version, quantity: 5 });
    expect(patch.body.error.code).toBe("INVALID_STATE");
    const rc = await approve(h, p.proposalId, "k-request-changes", "request_changes");
    expect(rc.body.data.decisionState).toBe("changes_requested");
    const patch2 = await h.call("PATCH", `/api/v1/requests/${p.id}`, { expectedVersion: req.body.data.version, quantity: 5 });
    expect(patch2.body.data.isCurrentVersionConfirmed).toBe(false);
    const revision = await h.call("POST", `/api/v1/requests/${p.id}/proposals`, { proposalId: p.proposalId, runId: p.runId, offerId: p.top.offerId });
    expect(revision.body.error.code).toBe("VERSION_CONFLICT");
  });

  it("duplicate submit and duplicate approval return one logical result", async () => {
    const h = harness();
    const p = await submittedProposal(h);
    const again = await h.call("POST", `/api/v1/proposals/${p.proposalId}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: p.amount });
    expect(again.status).toBe(200);
    const different = await h.call("POST", `/api/v1/proposals/${p.proposalId}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: p.amount + 1 });
    expect(different.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const [a, b] = await Promise.all([approve(h, p.proposalId, "same-key-123"), approve(h, p.proposalId, "same-key-123")]);
    const ok = [a, b].filter((x) => x.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const c = await approve(h, p.proposalId, "same-key-123");
    expect(c.status).toBe(200);
    expect(c.body.data.execution.id).toBe(ok[0]!.body.data.execution.id);
    expect(h.bank.createCalls).toBe(1);
    const conflict = await h.call("POST", `/api/v1/proposals/${p.proposalId}/decision`, { version: 1, decision: "reject", actor: "executive-demo" }, { "idempotency-key": "same-key-123" });
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const other = await approve(h, p.proposalId, "another-key-1");
    expect(other.body.error.code).toBe("INVALID_STATE");
    const missing = await h.call("POST", `/api/v1/proposals/${p.proposalId}/decision`, { version: 1, decision: "approve", actor: "executive-demo" });
    expect(missing.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("two concurrent approvals cannot oversubscribe the budget", async () => {
    // Balance $5,000, pending bill $1,200 -> $3,800 available. Two $2,000 approvals: only one fits.
    const h = harness();
    const a = await submittedProposal(h, 200000, { budgetCents: 300000 });
    const b = await submittedProposal(h, 200000, { budgetCents: 300000 });
    const [ra, rb] = await Promise.all([approve(h, a.proposalId), approve(h, b.proposalId)]);
    const codes = [ra, rb].map((r) => (r.status === 200 ? "ok" : r.body.error.code)).sort();
    expect(codes).toEqual(["BUDGET_EXCEEDED", "ok"]);
    expect(h.bank.createCalls).toBe(1);
  });
});

describe("budget reconciliation with Nessie balance behavior", () => {
  for (const reflects of [false, true]) {
    it(`remote balance ${reflects ? "changes" : "stays unchanged"}: no double charge, no overspend`, async () => {
      const bank = new FixtureBank({ balanceReflectsPurchases: reflects });
      const h = harness({ bank });
      const p = await submittedProposal(h, 100000);
      const d = await approve(h, p.proposalId);
      expect(d.body.data.execution.status).toBe("recorded");
      const budget = await h.call("GET", "/api/v1/budget?refresh=true", undefined, EXEC);
      // Either way the purchase is counted exactly once.
      expect(budget.body.data.availableBudgetCents).toBe(500000 - 120000 - 100000);
      expect(budget.body.data.unreflectedExpensesCents).toBe(reflects ? 0 : 100000);
    });
  }

  it("Nessie whole-dollar storage: discrepancy is shown and the balance drop still reconciles once", async () => {
    const bank = new FixtureBank({ balanceReflectsPurchases: true, wholeDollars: true });
    const h = harness({ bank });
    const p = await submittedProposal(h, 79656);
    const d = await approve(h, p.proposalId);
    const exe = d.body.data.execution;
    expect(exe.status).toBe("recorded");
    expect(exe.providerAmountCents).toBe(79600);
    expect(exe.amountDiscrepancyCents).toBe(56);
    expect(exe.amountNote).toMatch(/whole dollars/);
    const budget = await h.call("GET", "/api/v1/budget?refresh=true", undefined, EXEC);
    // Balance dropped by $796.00, matched to the expense by the stored amount: counted once.
    expect(budget.body.data.unreflectedExpensesCents).toBe(0);
    expect(budget.body.data.availableBudgetCents).toBe(500000 - 79600 - 120000);
  });

  it("missing bank context blocks execution but not research", async () => {
    const bank = new FixtureBank();
    bank.getAccount = async () => {
      throw new IntegrationError("nessie", "UPSTREAM_TIMEOUT", "Nessie timed out", "definitive", true);
    };
    const h = harness({ bank });
    const p = await submittedProposal(h);
    expect(p.run.status).toBe("completed");
    expect(p.run.financialContext.status).toBe("bank_check_unavailable");
    const d = await approve(h, p.proposalId);
    expect(d.status).toBe(503);
    expect(d.body.error.code).toBe("BANK_CHECK_UNAVAILABLE");
    expect(bank.createCalls).toBe(0);
  });
});

describe("execution failures and recovery", () => {
  it("definite write failure releases the reservation", async () => {
    const h = harness({ bank: new FixtureBank({ nextCreate: "definitive_error" }) });
    const p = await submittedProposal(h);
    const d = await approve(h, p.proposalId);
    expect(d.body.data.execution.status).toBe("failed");
    expect(d.body.data.execution.ledger[0].status).toBe("released");
    const budget = await h.call("GET", "/api/v1/budget", undefined, EXEC);
    expect(budget.body.data.activeReservationsCents).toBe(0);
  });

  it("ambiguous timeout keeps a hold; reconciliation never resends", async () => {
    const h = harness({ bank: new FixtureBank({ nextCreate: "timeout" }) });
    const p = await submittedProposal(h);
    const d = await approve(h, p.proposalId);
    const exe = d.body.data.execution;
    expect(exe.status).toBe("uncertain");
    expect(exe.ledger[0].status).toBe("active");
    const rec = await h.call("POST", `/api/v1/executions/${exe.id}/reconcile`, { action: "check" }, EXEC);
    expect(rec.body.data.status).toBe("uncertain");
    expect(h.bank.createCalls).toBe(1);
    const failed = await h.call("POST", `/api/v1/executions/${exe.id}/reconcile`, { action: "mark_failed" }, EXEC);
    expect(failed.body.data.status).toBe("failed");
    expect(failed.body.data.ledger[0].status).toBe("released");
  });

  it("success with a lost response is reconciled by reference without a duplicate purchase", async () => {
    const h = harness({ bank: new FixtureBank({ nextCreate: "ok_then_timeout" }) });
    const p = await submittedProposal(h);
    const d = await approve(h, p.proposalId);
    const exe = d.body.data.execution;
    expect(exe.status).toBe("uncertain");
    const rec = await h.call("POST", `/api/v1/executions/${exe.id}/reconcile`, {}, EXEC);
    expect(rec.body.data.status).toBe("recorded");
    expect(rec.body.data.externalReference.purchaseId).toBe("fixture_purchase_1");
    expect(h.bank.createCalls).toBe(1);
    expect(h.bank.state.purchases.length).toBe(1);
  });

  it("restart turns an in-flight submission into uncertain and preserves saved state", async () => {
    const config = testConfig();
    const h = harness({ config });
    const p = await submittedProposal(h);
    const d = await approve(h, p.proposalId);
    h.ctx.db.prepare("UPDATE executions SET status = 'submitting' WHERE id = ?").run(d.body.data.execution.id);
    h.ctx.db.close();
    const ctx2 = createContext(config, { adapters: { shopping: new FixtureShopping(), bank: h.bank, extractor: new FixtureExtractor() }, agentRunner: new ScriptedAgentRunner() });
    const row = ctx2.db.prepare("SELECT status FROM executions WHERE id = ?").get(d.body.data.execution.id) as { status: string };
    expect(row.status).toBe("uncertain");
    const req = ctx2.db.prepare("SELECT status FROM requests WHERE id = ?").get(p.id) as { status: string };
    expect(req.status).toBe("approved");
  });

  it("restart marks an interrupted research run failed instead of silently resuming", async () => {
    const config = testConfig();
    const h = harness({ config });
    const r = await researched(h);
    h.ctx.db.prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(r.runId);
    h.ctx.db.close();
    const ctx2 = createContext(config, { adapters: { shopping: new FixtureShopping(), bank: new FixtureBank(), extractor: new FixtureExtractor() }, agentRunner: new ScriptedAgentRunner() });
    const row = ctx2.db.prepare("SELECT status, error FROM runs WHERE id = ?").get(r.runId) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("INTERRUPTED");
  });
});
