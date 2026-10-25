import { describe, expect, it } from "vitest";
import { tabsFor } from "./nav";
import { homeFor } from "./auth/config";

describe("role navigation", () => {
  it("executives start at approvals and get Approvals, Activity and Account", () => {
    expect(homeFor("executive")).toBe("/executive");
    const { tabs, showCreate } = tabsFor("executive");
    expect(tabs.map((t) => t.label)).toEqual(["Approvals", "Activity", "Account"]);
    expect(showCreate).toBe(false);
    expect(tabs[0]!.match("/executive/prop_1")).toBe(true);
    expect(tabs[1]!.match("/requests/req_1")).toBe(true);
  });
  it("employees keep their request workflow", () => {
    expect(homeFor("employee")).toBe("/");
    const { tabs, showCreate } = tabsFor("employee");
    expect(tabs.map((t) => t.label)).toEqual(["Requests", "Account"]);
    expect(showCreate).toBe(true);
    expect(tabs[0]!.match("/")).toBe(true);
    expect(tabs.some((t) => t.href.startsWith("/executive"))).toBe(false);
  });
});
