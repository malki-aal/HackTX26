import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUNDLED_SCENARIOS } from "./index";

// Every API method is a spy: rendering the form (with examples available) must not create, confirm,
// research or call a model. Only the example list is read, through useLoad.
const api = vi.hoisted(() => ({
  mode: "live",
  getScenarios: vi.fn(),
  createRequest: vi.fn(),
  confirmRequirements: vi.fn(),
  startResearch: vi.fn(),
  createProject: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ api }));
vi.mock("@/components/ui", async (original) => ({
  ...(await original<typeof import("@/components/ui")>()),
  useLoad: () => ({ data: BUNDLED_SCENARIOS, loading: false, error: null, reload: vi.fn(), refresh: vi.fn(), setData: vi.fn() }),
}));

describe("New Request examples", () => {
  it("offers 'Start from scratch' plus the four sector examples in a labelled dropdown, with a live status region", async () => {
    const { default: NewRequestPage } = await import("../../app/new/page");
    const html = renderToStaticMarkup(createElement(NewRequestPage));
    expect(html).toContain('<label for="example"');
    expect(html).toContain("Try an example");
    expect(html).toContain(">Start from scratch</option>");
    for (const s of BUNDLED_SCENARIOS.scenarios) expect(html).toContain(`${s.sector} — ${s.menuLabel}`);
    expect(html).toMatch(/id="example-status" aria-live="polite"/);
    expect(html).not.toContain("Load desk organizer"); // the old cork/screw demo is gone
  });

  it("renders without creating a request or starting paid research", async () => {
    const { default: NewRequestPage } = await import("../../app/new/page");
    renderToStaticMarkup(createElement(NewRequestPage));
    for (const fn of [api.createRequest, api.confirmRequirements, api.startResearch, api.createProject]) expect(fn).not.toHaveBeenCalled();
  });
});
