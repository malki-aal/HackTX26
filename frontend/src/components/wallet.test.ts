import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Wallet } from "@/lib/api";

const wallet: Wallet = {
  account: { masked: "•••• 4242" },
  runwayBalanceCents: 51600,
  receivedCents: 103200,
  paidCents: 51600,
  reportedBalanceCents: 51600,
  disclaimer: "Sandbox",
  entries: [
    { type: "received", executionId: "exe_2", proposalId: "p2", requestId: "r2", title: "Intern monitors", amountCents: 51600, status: "recorded", at: "2026-10-25T12:00:00Z", seller: "Walmart", canPay: true },
    { type: "paid", executionId: "exe_1", proposalId: "p1", requestId: "r1", title: "Glue restock", amountCents: 51600, status: "recorded", at: "2026-10-25T11:00:00Z", seller: "Home Depot" },
    { type: "received", executionId: "exe_1", proposalId: "p1", requestId: "r1", title: "Glue restock", amountCents: 51600, status: "recorded", at: "2026-10-25T10:00:00Z", seller: "Home Depot", canPay: false },
  ],
};
const api = vi.hoisted(() => ({ getWallet: vi.fn(), payExecution: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useLoad: () => ({ data: wallet, loading: false, error: null, reload: vi.fn(), refresh: vi.fn(), setData: vi.fn() }),
  usePolling: () => {},
}));

describe("employee wallet card", () => {
  it("shows money received as green + and money paid as red −, with a Pay button only where the seller isn't paid yet", async () => {
    const { WalletCard } = await import("./wallet");
    const html = renderToStaticMarkup(createElement(WalletCard, {}));
    expect(html).toContain("Your Runway account");
    expect(html).toContain("•••• 4242");
    expect(html).toMatch(/text-ok">\+\$516\.00</);
    expect(html).toMatch(/text-bad">−\$516\.00</);
    expect(html).toContain("Received · Intern monitors");
    expect(html).toContain("Paid Home Depot");
    expect((html.match(/Pay Walmart/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Pay Home Depot");
    expect(api.payExecution).not.toHaveBeenCalled(); // rendering never pays
  });
});

describe("live adapter", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("pays with the Idempotency-Key header", async () => {
    vi.doMock("@/lib/auth/token", () => ({ getAuthToken: async () => null, UNAUTHORIZED_EVENT: "unauthorized" }));
    vi.doMock("@/lib/auth/config", () => ({ authMode: "demo" }));
    const { liveApi } = await vi.importActual<typeof import("@/lib/api/live")>("@/lib/api/live");
    const exe = { id: "exe_2", proposalId: "p2", status: "recorded", kind: "transfer", payment: { status: "recorded", amountCents: 51600, purchaseId: "pur_1", lastError: null, recordedAt: "x" }, providerStatus: "pending", externalReference: null, amountCents: 51600, providerAmountCents: null, amountDiscrepancyCents: null, amountNote: null, lastError: null, disclaimer: "d", createdAt: "x", updatedAt: "x" };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: exe }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const out = await liveApi.payExecution("exe_2", "pay-key-123456");
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toMatch(/\/executions\/exe_2\/pay$/);
    expect(init.method).toBe("POST");
    expect(init.headers["Idempotency-Key"]).toBe("pay-key-123456");
    expect(out).toMatchObject({ kind: "transfer", payment: { status: "recorded", purchaseId: "pur_1" } });
  });
});
