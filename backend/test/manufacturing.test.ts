import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { approve, harness, mapSeller, submittedProposal } from "./helpers.js";
import { awaitRun } from "../src/services/research.js";
import { CreateProjectBody } from "../src/contracts/domain.js";
import { FixtureBank } from "../src/integrations/fixtures.js";
import { httpJson, parseRetryAfter } from "../src/lib/http.js";
import { Semaphore } from "../src/integrations/serpapi.js";
import { IntegrationError } from "../src/lib/errors.js";

const DEMO = JSON.parse(readFileSync(new URL("../demo/manufacturing-desk-organizers.json", import.meta.url), "utf8"));
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** The demo file has a fixed date; tests use a needed-by date relative to today. */
const demo = (overrides: Record<string, unknown> = {}) => ({ ...DEMO, neededBy: day(12), ...overrides });

async function researchedProject(h: ReturnType<typeof harness>, body = demo()) {
  const created = await h.call("POST", "/api/v1/projects", body);
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.data.id;
  const conf = await h.call("POST", `/api/v1/projects/${id}/confirm`);
  const research = await h.call("POST", `/api/v1/projects/${id}/research`, {});
  for (const r of research.body.data.results) if (r.runId) await awaitRun(r.runId);
  return { id, created: created.body.data, conf: conf.body.data, research: research.body.data, project: (await h.call("GET", `/api/v1/projects/${id}`)).body.data };
}

async function proposeLowestCost(h: ReturnType<typeof harness>, requestId: string) {
  const c = (await h.call("GET", `/api/v1/requests/${requestId}/candidates`)).body.data;
  const rec = c.recommendations.find((r: any) => r.kinds.includes("lowest_cost"));
  const cand = c.candidates.find((x: any) => x.offerId === rec.offerId);
  const p = await h.call("POST", `/api/v1/requests/${requestId}/proposals`, { runId: c.runId, offerId: rec.offerId, justification: "Lowest known compliant cost" });
  const s = await h.call("POST", `/api/v1/proposals/${p.body.data.id}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: cand.knownComparableCostCents + 100 });
  if (s.status !== 200) throw new Error(JSON.stringify(s.body));
  return { proposalId: p.body.data.id as string, candidate: cand, amount: cand.knownComparableCostCents + 100 };
}

describe("manufacturing demo: desk organizers from leftover wood", () => {
  it("the demo input validates, keeps wood as supplied inventory, and line budgets fit the $100 cap", () => {
    const p = CreateProjectBody.parse(DEMO);
    expect(p.budgetCents).toBe(10000);
    expect(p.lines.map((l) => l.key)).toEqual(["glue", "cork", "screws"]);
    expect(p.lines.reduce((s, l) => s + l.budgetCents, 0)).toBeLessThanOrEqual(p.budgetCents);
    expect(p.suppliedInventory[0]!.name).toMatch(/walnut and maple/);
    expect(p.lines.some((l) => /walnut|maple|lumber|offcut|board/i.test(`${l.title} ${l.category}`))).toBe(false);
    expect(() => CreateProjectBody.parse({ ...DEMO, budgetCents: 5000 })).toThrow(/exceed the project budget/);
  });

  it("creates one confirmed line per material with quantities, units and specs, and finds compliant offers", async () => {
    const h = harness();
    const { project, conf } = await researchedProject(h);
    expect(conf.results.map((r: any) => r.result)).toEqual(["confirmed", "confirmed", "confirmed"]);
    const byKey = Object.fromEntries(project.lines.map((l: any) => [l.key, l]));
    expect(byKey.glue.item).toMatchObject({ category: "wood_glue", unit: "bottle", quantity: 1 });
    expect(byKey.cork.item).toMatchObject({ category: "cork_sheets", unit: "sheet", quantity: 5 });
    expect(byKey.screws.item).toMatchObject({ category: "wood_screws", unit: "screw", quantity: 40 });
    expect(byKey.screws.deadlineType).toBe("hard");
    for (const l of project.lines) {
      expect(l.research.runStatus).toBe("completed");
      expect(l.research.lowestCost).not.toBeNull();
    }
    // 5 sheets from 4-packs = 2 packs; 40 screws from a 100-pack = 1 pack.
    expect(byKey.cork.research.lowestCost.knownComparableCostCents).toBe(2998);
    expect(byKey.screws.research.lowestCost.knownComparableCostCents).toBe(698);
    expect(project.totals.fitsBudget).toBe("yes_provisional");
    expect(project.suppliedInventory[0]).toMatchObject({ purchased: false });
  });

  it("a cheaper but late offer is shown as noncompliant, never recommended (hard needed-by date)", async () => {
    const h = harness();
    const { project } = await researchedProject(h);
    const glue = project.lines.find((l: any) => l.key === "glue");
    const c = (await h.call("GET", `/api/v1/requests/${glue.requestId}/candidates`)).body.data;
    const late = c.candidates.find((x: any) => /Carpenter's Wood Glue/.test(x.title));
    expect(late.eligibility).toBe("rejected");
    expect(c.recommendations.map((r: any) => r.offerId)).not.toContain(late.offerId);
    expect(c.noncompliantAlternatives.map((a: any) => a.offerId)).toContain(late.offerId);
    // An offer with no stated delivery stays unknown under a hard deadline: needs review, not eligible.
    expect(c.candidates.find((x: any) => /16 oz/.test(x.title)).eligibility).toBe("needs_review");
  });

  it("approves each line against the project hard cap and blocks spending past it", async () => {
    const h = harness();
    const { project } = await researchedProject(h);
    const lines = Object.fromEntries(project.lines.map((l: any) => [l.key, l]));
    const glue = await proposeLowestCost(h, lines.glue.requestId);
    const cork = await proposeLowestCost(h, lines.cork.requestId);
    expect((await approve(h, glue.proposalId)).body.data.execution.status).toBe("recorded");
    expect((await approve(h, cork.proposalId)).body.data.execution.status).toBe("recorded");
    const after = (await h.call("GET", `/api/v1/projects/${project.id}`)).body.data;
    expect(after.totals.committedCents).toBe(glue.amount + cork.amount);
    // The project cap binds across approvals: a second approved proposal on a line (each within its
    // line budget) cannot push total commitments past the project budget.
    const runId = (await h.call("GET", `/api/v1/requests/${lines.cork.requestId}`)).body.data.latestRunId;
    const extra = async (amount: number) => {
      const p = await h.call("POST", `/api/v1/requests/${lines.cork.requestId}/proposals`, { runId, offerId: cork.candidate.offerId });
      const sub = await h.call("POST", `/api/v1/proposals/${p.body.data.id}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: amount });
      expect(sub.status).toBe(200);
      return approve(h, p.body.data.id);
    };
    expect((await extra(5000)).status).toBe(200); // within the line budget and the project cap
    const committed = glue.amount + cork.amount + 5000;
    const over = await extra(5000); // within the line budget, but past the $100 project cap
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("BUDGET_EXCEEDED");
    expect(over.body.error.details).toMatchObject({ projectId: project.id, projectBudgetCents: 10000, committedCents: committed });
    expect((await h.call("GET", `/api/v1/projects/${project.id}`)).body.data.totals).toMatchObject({ committedCents: committed, remainingCents: 10000 - committed });
  });
});

describe("Nessie merchant mapping", () => {
  it("execution requires an explicit mapping; nothing is reserved or written without one", async () => {
    const h = harness();
    const p = await submittedProposal(h);
    const r = await approve(h, p.proposalId, "k-no-map-1", "approve", 1, false);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MERCHANT_MAPPING_REQUIRED");
    expect(h.bank.createCalls).toBe(0);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM budget_ledger").get()).toEqual({ n: 0 });
    // After mapping, the same key can be retried and approval proceeds.
    await mapSeller(h, p.proposalId);
    const ok = await h.call("POST", `/api/v1/proposals/${p.proposalId}/decision`, { version: 1, decision: "approve", actor: "executive-demo" }, { "idempotency-key": "k-no-map-1" });
    expect(ok.body.data.execution.status).toBe("recorded");
    expect(ok.body.data.execution.merchantMapping).toMatchObject({ provenance: "created_sandbox_merchant", seller: p.top.seller });
  });

  it("only the executive role can map, linking requires an existing Nessie merchant, and provenance is recorded", async () => {
    const h = harness();
    const forbidden = await h.call("POST", "/api/v1/merchant-mappings", { action: "create_sandbox_merchant", seller: "Fixture Mart", actor: "employee-demo" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe("FORBIDDEN_ACTOR");
    const missing = await h.call("POST", "/api/v1/merchant-mappings", { action: "link_existing_merchant", seller: "Fixture Mart", nessieMerchantId: "does_not_exist", actor: "executive-demo" });
    expect(missing.status).toBe(404);
    const linked = await h.call("POST", "/api/v1/merchant-mappings", { action: "link_existing_merchant", seller: "Fixture Mart", nessieMerchantId: "fixture_merchant_existing", actor: "executive-demo" });
    expect(linked.status).toBe(201);
    expect(linked.body.data).toMatchObject({ provenance: "linked_existing_merchant", nessieMerchantId: "fixture_merchant_existing" });
    expect(linked.body.data.disclaimer).toMatch(/not the seller's real merchant account/);
    const created = await h.call("POST", "/api/v1/merchant-mappings", { action: "create_sandbox_merchant", seller: "Fixture Electronics", actor: "executive-demo" });
    expect(created.body.data.merchant.name).toBe("Runway sandbox: Fixture Electronics");
    const dup = await h.call("POST", "/api/v1/merchant-mappings", { action: "create_sandbox_merchant", seller: "fixture electronics", actor: "executive-demo" });
    expect(dup.status).toBe(409);
    const details = await h.call("GET", `/api/v1/merchants/${created.body.data.nessieMerchantId}`);
    expect(details.body.data).toMatchObject({ merchant: { name: "Runway sandbox: Fixture Electronics" }, mappedSellers: [{ seller: "Fixture Electronics", provenance: "created_sandbox_merchant" }] });
  });
});

describe("confirmation record, activity and purchase history", () => {
  it("persists everything the confirmation screen needs, without inventing fulfillment", async () => {
    const h = harness({ bank: new FixtureBank({ wholeDollars: true }) });
    const p = await submittedProposal(h, 79656);
    await approve(h, p.proposalId);
    const c = (await h.call("GET", `/api/v1/proposals/${p.proposalId}/confirmation`)).body.data;
    expect(c).toMatchObject({
      proposalId: p.proposalId,
      requestId: p.id,
      item: { category: "monitors" },
      requester: { id: "employee-demo", demoIdentity: true },
      approver: { id: "executive-demo", decision: "approve" },
      account: { masked: "•••• 3333" },
      merchant: { researchedSeller: p.top.seller, mapped: true, provenance: "created_sandbox_merchant" },
      amounts: { approvedAmountCents: 79656, providerStoredAmountCents: 79600, discrepancyCents: 56, currency: "USD" },
      provider: { purchaseId: "fixture_purchase_1", status: "pending" },
      statuses: { decision: "approved", execution: "recorded", provider: "pending" },
    });
    for (const k of ["submittedAt", "approvedAt", "providerSubmittedAt", "recordedAt", "providerRetrievedAt"]) expect(c.timestamps[k]).toBeTruthy();
    expect(c.evidenceLinks[0].url).toMatch(/^https:\/\/example.invalid/);
    expect(c.discrepancies[0]).toMatch(/whole dollars/);
    expect(JSON.stringify(c)).not.toMatch(/tracking|shipped|delivered|order id|receipt number/i);
    expect(c.notice).toMatch(/not a merchant checkout, order, receipt, shipment or delivery confirmation/);
    expect(JSON.stringify(c)).not.toContain("0000111122223333");
  });

  it("separates approval-pending, unexecuted, uncertain and provider-pending items", async () => {
    const h = harness({ bank: new FixtureBank({ nextCreate: "timeout" }) });
    const awaiting = await submittedProposal(h);
    const uncertain = await submittedProposal(h);
    await approve(h, uncertain.proposalId);
    h.bank.state.nextCreate = "ok";
    const pending = await submittedProposal(h);
    await approve(h, pending.proposalId);
    const a = (await h.call("GET", "/api/v1/activity")).body.data;
    expect(a.groups.awaitingApproval.map((x: any) => x.proposalId)).toEqual([awaiting.proposalId]);
    expect(a.groups.executionInProgressOrUncertain.map((x: any) => x.proposalId)).toEqual([uncertain.proposalId]);
    expect(a.groups.providerPending.map((x: any) => x.proposalId)).toEqual([pending.proposalId]);
    expect(a.counts).toMatchObject({ awaitingApproval: 1, approvedNotExecuted: 0, executionInProgressOrUncertain: 1, providerPending: 1 });
  });

  it("purchase history comes from the account's purchases and links Runway executions", async () => {
    const h = harness();
    const p = await submittedProposal(h);
    const d = await approve(h, p.proposalId);
    h.bank.state.purchases.push({ id: "external_1", merchantId: "fixture_merchant_existing", amountCents: 1200, rawAmount: 12, status: "completed", medium: "balance", description: "Coffee", date: "2026-10-20" });
    const hist = (await h.call("GET", "/api/v1/purchase-history")).body.data;
    const ours = hist.purchases.find((x: any) => x.purchaseId === "fixture_purchase_1");
    expect(ours).toMatchObject({ origin: "runway", runway: { executionId: d.body.data.execution.id, proposalId: p.proposalId } });
    expect(ours.merchant.mappedSeller).toBe(p.top.seller);
    expect(hist.purchases.find((x: any) => x.purchaseId === "external_1")).toMatchObject({ origin: "external", runway: null, merchant: { name: "[FIXTURE] Existing sandbox merchant" } });
  });
});

describe("provider rate limiting", () => {
  afterEach(() => vi.unstubAllGlobals());
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

  it("parses Retry-After in seconds and HTTP-date form", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThanOrEqual(9);
    expect(parseRetryAfter(null)).toBeNull();
  });

  it("waits out a short Retry-After on a safe read, then succeeds", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(res(429, { error: "Too many requests" }, { "retry-after": "1" })).mockResolvedValueOnce(res(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const t = Date.now();
    const r = await httpJson({ service: "serpapi", method: "GET", url: "https://serpapi.com/search.json?api_key=x", timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  });

  it("surfaces a long Retry-After immediately with the wait, and an exhausted quota as non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(429, { error: "Too many requests" }, { "retry-after": "120" })));
    const e1 = await httpJson({ service: "serpapi", method: "GET", url: "https://serpapi.com/x", timeoutMs: 5000 }).catch((e) => e);
    expect(e1).toBeInstanceOf(IntegrationError);
    expect(e1.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(e1.details).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 120 });
    expect(e1.retryable).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res(429, { error: "Your account has run out of searches." })));
    const e2 = await httpJson({ service: "serpapi", method: "GET", url: "https://serpapi.com/x", timeoutMs: 5000 }).catch((e) => e);
    expect(e2.details.kind).toBe("quota_exhausted");
    expect(e2.retryable).toBe(false);
    expect(e2.message).toMatch(/quota exhausted/);
  });

  it("a rate-limited search fails the run with a clear code and the provider's wait", async () => {
    const { FixtureShopping } = await import("../src/integrations/fixtures.js");
    const h = harness({ shopping: new FixtureShopping(null, { failWith: new IntegrationError("serpapi", "UPSTREAM_RATE_LIMITED", "serpapi rate limited; retry after 120s", "definitive", true, 429, { kind: "rate_limited", retryAfterSeconds: 120 }) }) });
    const created = await h.call("POST", "/api/v1/requests", { title: "Wood glue", description: "New wood glue, 8 fl oz", quantity: 1, currency: "USD", budgetCents: 2000, allowedCondition: "new" });
    await h.call("POST", `/api/v1/requests/${created.body.data.id}/confirm`, { version: 1 });
    const s = await h.call("POST", `/api/v1/requests/${created.body.data.id}/research`, { version: 1 });
    await awaitRun(s.body.data.runId);
    const run = (await h.call("GET", `/api/v1/runs/${s.body.data.runId}`)).body.data;
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "UPSTREAM_RATE_LIMITED", details: { retryAfterSeconds: 120 } });
  });

  it("bounds concurrent provider calls", async () => {
    const sem = new Semaphore(2);
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, sem.inFlight);
          await new Promise((r) => setTimeout(r, 10));
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
