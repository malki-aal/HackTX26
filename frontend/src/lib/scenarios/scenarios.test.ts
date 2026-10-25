import { describe, expect, it } from "vitest";
import { BLANK_FORM, BUNDLED_SCENARIOS, dateInZone, isDirty, presetToForm } from "./index";

const byId = (id: string) => BUNDLED_SCENARIOS.scenarios.find((s) => s.id === id)!;
const tz = BUNDLED_SCENARIOS.timezone;

describe("example presets", () => {
  it("offer the four sectors with short menu labels", () => {
    expect(BUNDLED_SCENARIOS.scenarios.map((s) => `${s.sector} — ${s.menuLabel}`)).toEqual([
      "Manufacturing — Restock wood glue",
      "Growing business — Equip incoming interns",
      "Café — Replace a broken blender",
      "Community nonprofit — Power an outreach event",
    ]);
  });

  it("fill every editable field, with concrete dates computed when loaded", () => {
    const now = new Date("2026-10-25T15:00:00Z"); // 10:00 in Chicago
    const glue = presetToForm(byId("manufacturing_wood_glue"), tz, now);
    expect(glue).toEqual({
      title: "Restock wood glue",
      purpose: expect.stringContaining("128 US fluid ounces total"),
      itemName: "Wood glue",
      quantity: "128",
      unit: "US fluid ounces",
      budget: "100",
      mandatory: "Explicit suitability for interior hardwood assembly\nNew and unopened",
      preferences: "Fewer containers",
      condition: "new",
      deadline: "2026-11-01",
      deadlineKind: "hard",
    });
    expect(presetToForm(byId("growing_business_monitors"), tz, now)).toMatchObject({ quantity: "4", unit: "monitors", budget: "1000", deadline: "2026-11-04" });
    expect(presetToForm(byId("cafe_blender"), tz, now)).toMatchObject({ quantity: "1", budget: "300", deadline: "2026-10-28", preferences: "" });
    expect(presetToForm(byId("nonprofit_power_station"), tz, now)).toMatchObject({ budget: "500", deadline: "2026-11-01", mandatory: "At least 500 Wh battery capacity\nAt least two AC outlets" });
  });

  it("use the app's timezone for 'today', not the device's UTC date", () => {
    // 03:00 UTC on Oct 26 is still Oct 25 in Chicago.
    expect(dateInZone(0, "America/Chicago", new Date("2026-10-26T03:00:00Z"))).toBe("2026-10-25");
    expect(dateInZone(7, "America/Chicago", new Date("2026-10-26T03:00:00Z"))).toBe("2026-11-01");
  });

  it("detect unsaved edits so a preset never silently overwrites them", () => {
    expect(isDirty(BLANK_FORM, BLANK_FORM)).toBe(false);
    expect(isDirty({ ...BLANK_FORM, title: "My own title" }, BLANK_FORM)).toBe(true);
    const loaded = presetToForm(byId("cafe_blender"), tz);
    expect(isDirty(loaded, loaded)).toBe(false);
    expect(isDirty({ ...loaded, budget: "350" }, loaded)).toBe(true);
  });
});
