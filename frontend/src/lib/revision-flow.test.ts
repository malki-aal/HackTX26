import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { currentRevisionDecision } from "./api/mappers";
import { liveApi } from "./api/live";
import { DecisionRecord, ExceptionsRecord } from "@/components/review";
import type { Proposal } from "./api/types";

vi.mock("./auth/token", () => ({ getAuthToken: async () => null, UNAUTHORIZED_EVENT: "unauthorized" }));
vi.mock("./auth/config", () => ({ authMode: "demo" }));
afterEach(() => vi.unstubAllGlobals());

const v1Changes = { version: 1, at: "2026-10-25T11:20:00Z", decision: "request_changes", actor: { displayName: "Erin Exec", demo: false }, note: "Lower the quantity to 2" };
const base: Proposal = {
  id: "prop_1", requestId: "req_1", requestTitle: "Intern monitors", revision: 2, lines: [], justification: "Revised",
  suitabilityConfirmed: true, researchSubtotalCents: 25800, budgetCeilingCents: 100000, expenseCents: 25800, expenseSource: "user_confirmed",
  decision: "awaiting_review", requester: { displayName: "Sam Lee", demo: false }, execution: "not_started", unresolved: [],
  requirementResolutions: [], submittedAt: "2026-10-25T11:40:00Z",
  review: { purpose: "", requirements: [], findings: [], observedAt: null, expiresAt: null, stale: false, fromCache: false,
    cost: { unitPriceCents: null, packagesRequired: null, listedSubtotalCents: null, shippingCents: null, taxCents: null, totalStatus: "x" },
    alternatives: [], budget: { status: "x", availableCents: null, notes: [] }, history: [v1Changes], revisions: [] },
};

describe("a resubmitted revision is not shown as already decided", () => {
  it("only a decision on the current revision describes it", () => {
    const decisions = [{ version: 1, decision: "request_changes" }];
    expect(currentRevisionDecision(decisions, 2)).toBeUndefined();
    expect(currentRevisionDecision([...decisions, { version: 2, decision: "approve" }], 2)).toMatchObject({ decision: "approve" });
  });

  it("shows revision 2 as awaiting with its submission time, and revision 1's decision only as history", () => {
    const html = renderToStaticMarkup(createElement(DecisionRecord, { p: base }));
    expect(html).toContain("Revision 2");
    expect(html).toContain("Awaiting");
    expect(html).toContain("Submitted");
    expect(html).not.toContain("Decided by");
    expect(html).toContain("Previous decision · revision 1");
    expect(html).toContain("Lower the quantity to 2");
  });

  it("shows the current decision with its own time once revision 2 is decided", () => {
    const p: Proposal = { ...base, decision: "approved", approval: { actor: { displayName: "Erin Exec", demo: false }, at: "2026-10-25T12:00:00Z", decision: "approve" }, decisionNote: "Looks good" };
    const html = renderToStaticMarkup(createElement(DecisionRecord, { p }));
    expect(html).toContain("Decided by Erin Exec");
    expect(html).toContain("Looks good");
    expect(html).toContain("Previous decision · revision 1");
  });
});

describe("accepted exceptions stay visible after approval", () => {
  it("lists the requester's notes with the revision, without calling the evidence confirmed", () => {
    const p: Proposal = {
      ...base, decision: "approved",
      requirementResolutions: [{ requirement: "Condition: new", kind: "exception", note: "Seller did not state condition; acceptable for interns", evidenceReason: "Inferred new (no second-hand condition reported); not stated by the listing" }],
    };
    const html = renderToStaticMarkup(createElement(ExceptionsRecord, { p }));
    expect(html).toContain("Approved with exceptions · revision 2");
    expect(html).toContain("Seller did not state condition");
    expect(html).toContain("Listing evidence: Inferred new");
    expect(html).toContain("stays unconfirmed");
    expect(renderToStaticMarkup(createElement(ExceptionsRecord, { p: base }))).toBe("");
  });
});

describe("editing a request after changes were requested", () => {
  it("PATCHes a new version with the changed quantity, budget and specs, and never starts research", async () => {
    const reqView = { id: "req_1", version: 3, status: "ready_to_confirm", isCurrentVersionConfirmed: false, title: "Intern monitors", purpose: "Two interns", category: "monitors",
      item: { resolved: true, category: "monitors", label: "monitor", plural: "monitors", unit: "monitor" }, quantity: 2, totalBudgetCents: 50000, allowedCondition: "new",
      deadline: null, agentConfigId: "cfg_default", agentConfigVersion: null, requirements: [], questions: [], latestRunId: "run_old", proposals: [{ id: "prop_1", version: 1, decisionState: "changes_requested" }], createdAt: "x", updatedAt: "x" };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: reqView }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const out = await liveApi.updateRequest("req_1", {
      expectedVersion: 2, title: "Intern monitors", purpose: "Two interns", items: [{ name: "Computer monitors", quantity: 2, unit: "monitors" }],
      budgetTotalCents: 50000, mandatory: ["At least 27 inches", "HDMI"], preferences: [], condition: "new", deadlineKind: "flexible", agentConfigId: "cfg_default",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toMatch(/\/requests\/req_1$/);
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ expectedVersion: 2, quantity: 2, budgetCents: 50000, allowedCondition: "new" });
    expect(body.description).toContain("At least 27 inches (required).");
    expect(out).toMatchObject({ version: 3, status: "awaiting_confirmation", proposalDecision: "changes_requested" });
  });
});
