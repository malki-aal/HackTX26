// Integration-pass coverage: honest requirement handling at submission, the request-changes revision
// path, the queue contract the frontend maps, research lookups that cannot help, and the agent's
// quota-progress channel. Fixtures only: no model, search or bank calls.
import { describe, expect, it } from "vitest";
import { EXEC, harness, researched, submittedProposal } from "./helpers.js";
import { FIXTURE_MONITOR_ITEMS, FixtureShopping } from "../src/integrations/fixtures.js";
import { detailsCanHelp } from "../src/services/research.js";

const decide = (h: ReturnType<typeof harness>, id: string, body: Record<string, unknown>, key: string) =>
  h.call("POST", `/api/v1/proposals/${id}/decision`, body, { ...EXEC, "idempotency-key": key });

describe("unconfirmed must-haves at submission", () => {
  it("are never treated as met: submission needs a recorded verification or exception for each", async () => {
    // Listings that never state their condition: "new" is only inferred, so condition stays unknown.
    const h = harness({ shopping: new FixtureShopping(FIXTURE_MONITOR_ITEMS) });
    const r = await researched(h);
    const cand = r.candidates.find((c) => c.eligibility === "needs_review" && c.requirementChecks.some((k: any) => k.attribute === "condition" && k.state === "unknown"));
    expect(cand, "a needs-review candidate with inferred condition").toBeTruthy();
    expect(cand.requirementChecks.find((k: any) => k.attribute === "condition").reason).toMatch(/Inferred new/);
    const p = await h.call("POST", `/api/v1/requests/${r.id}/proposals`, { runId: r.runId, offerId: cand.offerId, justification: "Closest option" });
    expect(p.status).toBe(201);
    const pid = p.body.data.id;
    const amount = (cand.knownComparableCostCents ?? 50000) + 1000;

    const bare = await h.call("POST", `/api/v1/proposals/${pid}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: amount });
    expect([bare.status, bare.body.error.code]).toEqual([422, "UNRESOLVED_REQUIREMENTS"]);
    const open: Array<{ requirementId: string; attribute: string }> = bare.body.error.details.requirements;
    expect(open.map((o) => o.attribute)).toContain("condition");

    const stray = await h.call("POST", `/api/v1/proposals/${pid}/submit`, {
      version: 1, technicalReviewConfirmed: true, exactAmountCents: amount,
      requirementResolutions: [{ requirementId: "req_not_open", kind: "verified", note: "Checked" }],
    });
    expect(stray.status).toBe(422);

    const resolutions = open.map((o, i) => ({ requirementId: o.requirementId, kind: i === 0 ? "verified" : "exception", note: i === 0 ? "Seller confirmed by chat: brand new, sealed" : "Acceptable for a prototype bench" }));
    const ok = await h.call("POST", `/api/v1/proposals/${pid}/submit`, { version: 1, technicalReviewConfirmed: true, exactAmountCents: amount, requirementResolutions: resolutions });
    expect(ok.status).toBe(200);
    expect(ok.body.data.decisionState).toBe("awaiting_review");
    expect(ok.body.data.requirementResolutions.map((x: any) => x.kind)).toEqual(resolutions.map((x) => x.kind));
    // The evidence itself is unchanged: still unknown, still needs review.
    const view = (await h.call("GET", `/api/v1/proposals/${pid}`, undefined, EXEC)).body.data;
    expect(view.evaluation.class).toBe("needs_review");
    expect(view.evaluation.requirementResults.find((x: any) => x.attribute === "condition").state).toBe("unknown");
  });

  it("product-detail lookups are skipped when only condition is unconfirmed", () => {
    const base = { mandatory: true, requirementId: "r", evidenceIds: [], reason: "" };
    const onlyCondition = { requirementResults: [{ ...base, attribute: "condition", state: "unknown" }] } as any;
    const portUnknown = { requirementResults: [{ ...base, attribute: "condition", state: "unknown" }, { ...base, attribute: "port", state: "unknown" }] } as any;
    expect(detailsCanHelp(onlyCondition)).toBe(false);
    expect(detailsCanHelp(portUnknown)).toBe(true);
  });
});

describe("request changes, revise and resubmit", () => {
  it("the note reaches the employee, a new revision is reviewed, and the old version cannot be decided", async () => {
    const h = harness();
    const s = await submittedProposal(h);
    const sent = await decide(h, s.proposalId, { version: 1, decision: "request_changes", note: "Find a seller with stated delivery" }, "request-changes-0001");
    expect(sent.status).toBe(200);

    const mine = (await h.call("GET", `/api/v1/proposals/${s.proposalId}`)).body.data;
    expect(mine.decisionState).toBe("changes_requested");
    expect(mine.decisions.at(-1).note).toBe("Find a seller with stated delivery");
    expect(mine.budgetAssessment.availableBudgetCents === null || typeof mine.budgetAssessment.availableBudgetCents === "number").toBe(true);

    const rev = await h.call("POST", `/api/v1/requests/${s.id}/proposals`, { runId: s.runId, offerId: s.top.offerId, justification: "Revised", proposalId: s.proposalId });
    expect([rev.status, rev.body.data.version, rev.body.data.decisionState]).toEqual([201, 2, "not_submitted"]);
    const sub = await h.call("POST", `/api/v1/proposals/${s.proposalId}/submit`, { version: 2, technicalReviewConfirmed: true, exactAmountCents: s.amount });
    expect(sub.status).toBe(200);

    const q = await h.call("GET", "/api/v1/proposals?decisionState=awaiting_review", undefined, EXEC);
    const row = q.body.data.find((x: any) => x.id === s.proposalId);
    expect(row.version).toBe(2);
    // The queue gives the selected product separately from the request title, and the verified requester.
    expect(row.offer.title).not.toBe(row.title);
    expect(row.employee).toMatchObject({ displayName: "Demo Employee", demoIdentity: true });
    expect(row.latestDecision).toMatchObject({ decision: "request_changes", note: "Find a seller with stated delivery", version: 1 });
    expect(q.body.meta.counts.awaiting_review).toBe(1);

    const stale = await decide(h, s.proposalId, { version: 1, decision: "reject", note: "" }, "stale-version-0001");
    expect([stale.status, stale.body.error.code]).toEqual([409, "VERSION_CONFLICT"]);
    const preview = await h.call("GET", `/api/v1/proposals/${s.proposalId}/financial-preview`, undefined, EXEC);
    expect(preview.body.data.proposalVersion).toBe(2);
  });
});

describe("agent progress channel", () => {
  it("only accepts the internal token from loopback, with a sane wait", async () => {
    const h = harness();
    const noAuth = await h.app.inject({ method: "POST", url: "/internal/agent-progress", payload: { waitMs: 5000 } });
    expect(noAuth.statusCode).toBe(401);
    const bad = await h.app.inject({ method: "POST", url: "/internal/agent-progress", headers: { authorization: `Bearer ${"t".repeat(64)}` }, payload: { waitMs: -1 } });
    expect(bad.statusCode).toBe(400);
    const ok = await h.app.inject({ method: "POST", url: "/internal/agent-progress", headers: { authorization: `Bearer ${"t".repeat(64)}` }, payload: { waitMs: 12000 } });
    expect(ok.statusCode).toBe(200);
  });
});
