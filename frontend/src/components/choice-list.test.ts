import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChoiceList, needsChoiceList } from "./ui";

// The category question that ran off a phone screen as a one-line pill row.
const options = [
  { value: "monitors", label: "Monitors" },
  { value: "wood_glue", label: "Wood glue" },
  { value: "countertop_blender", label: "Countertop blenders" },
  { value: "portable_power_station", label: "Portable power stations" },
  { value: "general", label: "Something else (general search, every result needs review)" },
];

describe("clarification choices on a phone", () => {
  it("use a stacked, wrapping list when there are many or long options", () => {
    expect(needsChoiceList(options)).toBe(true);
    expect(needsChoiceList([{ label: "Total" }, { label: "Per item" }])).toBe(false);
    const html = renderToStaticMarkup(createElement(ChoiceList<string>, { label: "What item is this request for?", value: "", options, onChange: () => {} }));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("flex-col");
    expect(html).toContain("break-words");
    expect(html).not.toContain("whitespace-nowrap");
    expect((html.match(/role="radio"/g) ?? []).length).toBe(5);
  });
});
