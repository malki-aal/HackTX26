import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NewRequestPage from "../app/new/page";
import ProposalPage from "../app/requests/[id]/proposal/page";
import RequestDetailPage from "../app/requests/[id]/page";
import type { Offer, PurchaseRequest } from "./api/types";

const state = vi.hoisted(() => ({ loads: [] as unknown[] }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "req_test" }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams("sel=item_1:offer_1") }));
vi.mock("@/components/profile-menu", () => ({ ProfileMenu: () => null }));
vi.mock("@/lib/api", () => ({ api: { mode: "live" } }));
vi.mock("@/components/ui", async (original) => ({
  ...await original<typeof import("@/components/ui")>(),
  useLoad: () => ({ data: state.loads.shift() ?? null, loading: false, error: null, reload: vi.fn(), refresh: vi.fn(), setData: vi.fn() }),
  usePolling: () => {},
}));

const req: PurchaseRequest = { id: "req_test", version: 1, title: "New Chairs", purpose: "The office", category: "office_chairs", items: [{ id: "item_1", name: "office chairs", quantity: 4, unit: "chair" }], budgetTotalCents: 240000, mandatory: ["Ergonomic"], preferences: [], condition: "any", deadlineKind: "hard", agentConfigId: "cfg_default", status: "results_ready", clarifications: [], createdAt: "2026-10-25", updatedAt: "2026-10-25" };
const offer: Offer = { id: "offer_1", itemId: "item_1", title: "Ergonomic office chair", seller: "Target", url: "https://example.com/chair", observedAt: "2026-10-25", unitPriceCents: 4999, packageQuantity: 1, packagesRequired: 4, listedSubtotalCents: 19996, shippingCents: 0, taxCents: null, delivery: { status: "unknown" }, deadlineFit: "unknown", highlights: [], eligibility: "eligible", findings: [], rankNote: "", unresolved: [], affordability: "within_budget_provisional", costNotes: [], stale: false, fromCache: false };

beforeEach(() => { state.loads = []; });
describe("rendered requester screens", () => {
  it("has a clear search action without the agent selector or deadline lecture", () => {
    const html = renderToStaticMarkup(createElement(NewRequestPage));
    expect(html).toContain("Find options");
    expect(html).not.toContain("Agent configuration");
    expect(html).not.toContain("Options that arrive later");
  });
  it("renders the selected four-chair price as the proposed total, not its budget", () => {
    state.loads = [req, [offer], null];
    const html = renderToStaticMarkup(createElement(ProposalPage));
    expect(html).toContain("199");
    expect(html).toContain(".96");
    expect(html).toContain("Additional tax or shipping");
    expect(html).not.toContain("Three different amounts");
    expect(html).not.toContain('id="expense" inputMode="decimal" class="'); // field has an explicit zero placeholder, never the budget
    expect(html).toContain('placeholder="0.00"');
    expect(html).not.toContain("I reviewed these offers and they are technically suitable");
  });
  it("shows readable condition and combines confirmation with search", () => {
    state.loads = [{ ...req, status: "awaiting_confirmation" }];
    const html = renderToStaticMarkup(createElement(RequestDetailPage));
    expect(html).toContain("Any condition");
    expect(html).toContain("Find options");
    expect(html).not.toContain("Confirm requirements");
    expect(html).not.toContain("Step 1 of 6");
  });
});
