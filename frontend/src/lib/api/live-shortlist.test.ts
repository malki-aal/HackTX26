import { afterEach, describe, expect, it, vi } from "vitest";
import { liveApi } from "./live";

vi.mock("../auth/token", () => ({ getAuthToken: async () => null, UNAUTHORIZED_EVENT: "unauthorized" }));
vi.mock("../auth/config", () => ({ authMode: "demo" }));

const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

const request = {
  id: "req_1", version: 1, status: "researched", isCurrentVersionConfirmed: true, title: "Café blender", purpose: "", category: "countertop_blender",
  item: { name: "blender" }, quantity: 1, totalBudgetCents: 30000, allowedCondition: "new", deadline: "2026-10-28", deadlineType: "hard",
  agentConfigId: "cfg_default", agentConfigVersion: null, questions: [], latestRunId: "run_1", proposals: [],
  requirements: [
    { id: "req_volume", attribute: "volume", operator: "gte", value: 1893, unit: "ml", mandatory: true, sourceText: "" },
    { id: "req_delivery_by", attribute: "delivery_by", operator: "lte", value: "2026-10-28", mandatory: true, sourceText: "" },
  ],
};
const candidate = (offerId: string, extra: Record<string, unknown> = {}) => ({
  rank: 1, offerId, eligibility: "needs_review", affordability: "within_budget_provisional", title: `Blender ${offerId}`, imageUrl: null, seller: "Shop", sourceUrl: null,
  unitPriceCents: 16149, packageQuantity: 1, packagesRequired: 1, listedSubtotalCents: 16149, shippingCents: 0, costNotes: [], evidence: [], unknowns: [],
  recommendationReason: "Needs review: Specs match · confirm new condition", observedAt: "2026-10-25T14:08:08Z", expiresAt: "2026-10-25T14:38:08Z", stale: false, fromCache: false,
  delivery: { status: "stated", excerpt: "Free delivery by Wed", earliest: "2026-10-28", latest: "2026-10-28", basis: "google_estimate", location: null },
  requirementChecks: [
    { requirementId: "req_volume", attribute: "volume", state: "supported", evidenceIds: [], reason: "States 67.6 fl oz" },
    { requirementId: "req_delivery_by", attribute: "delivery_by", state: "unknown", evidenceIds: [], reason: "Google Shopping estimates delivery (no delivery location set, so not confirmed for your address) by Wed, Oct 28", deadlineRisk: "on_deadline" },
  ],
  ...extra,
});

describe("live shortlist mapping", () => {
  it("maps shortlist cards, statuses and delivery estimates without treating an estimate as arrival", async () => {
    const shortlist = {
      headline: "No option meets every must-have with confirmed evidence yet.",
      notEvaluated: [],
      entries: [{ offerId: "off_b", role: "closest_match", label: "Closest match so far", status: "Confirm new condition", compliance: "unconfirmed", explanation: "Confirmed: at least 64 fl oz.", compromise: "New condition remains unconfirmed.", unverified: ["Sales tax"], source: "deterministic" }],
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response(request))
      .mockResolvedValueOnce(response({ candidates: [candidate("off_a"), candidate("off_b")], shortlist }));
    vi.stubGlobal("fetch", fetcher);
    const offers = await liveApi.listCandidates("req_1");
    const [a, b] = offers;
    expect(b.shortlist).toMatchObject({ position: 1, label: "Closest match so far", status: "Confirm new condition", compliance: "unconfirmed" });
    expect(a.shortlist).toBeUndefined();
    expect(a.statusLine).toBe("Specs match · confirm new condition");
    expect(a.shortlistHeadline).toBe(shortlist.headline);
    // Google's date is an estimate for an unknown location: never "Arrives by your date".
    expect(a.deadlineFit).toBe("unknown");
    expect(a.delivery).toMatchObject({ status: "stated", text: "Google estimate: Free delivery by Wed", estimate: true });
    expect(a.deliveryNote).toMatch(/not confirmed for your address/);
  });

  it("works with responses from before the shortlist existed", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(request)).mockResolvedValueOnce(response({ candidates: [candidate("off_a", { eligibility: "eligible" })] }));
    vi.stubGlobal("fetch", fetcher);
    const [a] = await liveApi.listCandidates("req_1");
    expect(a.shortlist).toBeUndefined();
    expect(a.shortlistHeadline).toBeNull();
    expect(a.statusLine).toBe("Meets checked requirements");
  });
});
