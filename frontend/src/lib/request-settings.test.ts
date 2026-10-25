import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = (name: string) => readFileSync(new URL(`../app/${name}/page.tsx`, import.meta.url), "utf8");

describe("request research settings wiring", () => {
  it("uses the explicit default rather than the alphabetically first preset", () => {
    const source = page("new");
    expect(source).toContain('agentConfigId: "cfg_default"');
    expect(source).not.toContain("listAgentConfigs");
    expect(source).not.toContain("configs.data?.[0]");
    expect(source).not.toContain('label="Agent configuration"');
  });

  it("keeps the settings link executive-only", () => {
    expect(page("account")).toMatch(/\{isExecutive && \(\s*<Link href="\/settings"/);
  });

  it("gates the settings component before mounting its data loaders", () => {
    const source = page("settings");
    const gate = source.slice(source.indexOf("export default function SettingsPage"), source.indexOf("function ResearchSettings"));
    expect(gate).toContain('identity.status !== "ready"');
    expect(gate).toContain('identity.role !== "executive"');
    expect(gate.indexOf('identity.role !== "executive"')).toBeLessThan(gate.indexOf("return <ResearchSettings"));
    expect(gate).not.toContain("useLoad");
    expect(source).toContain("<details>");
    expect(source).not.toContain(">v{c.version}");
  });
});
