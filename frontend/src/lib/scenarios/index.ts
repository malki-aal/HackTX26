// Example presets for the New Request form. The source of truth is backend/demo/scenarios.json (served at
// GET /demo/scenarios); this folder keeps an identical copy for sample-data mode, checked by a backend test.
// Presets only fill editable inputs: applying one never creates a request, calls a model or searches.
import type { Condition, DeadlineKind } from "../api/types";
import BUNDLED from "./scenarios.json";

export interface ScenarioPreset {
  id: string;
  sector: string;
  menuLabel: string;
  title: string;
  purpose: string;
  item: string;
  categoryId: string;
  quantity: number;
  unit: string;
  budgetCents: number;
  condition: Condition;
  deadlineDays: number;
  deadlineType: "hard" | "target";
  eventDays: number | null;
  mandatory: string[];
  preferences: string[];
}

export interface ScenarioSet {
  version: number;
  timezone: string;
  scenarios: ScenarioPreset[];
}

export const BUNDLED_SCENARIOS = BUNDLED as ScenarioSet;

/** The editable fields of a single-item New Request form. */
export interface RequestFormState {
  title: string;
  purpose: string;
  itemName: string;
  quantity: string;
  unit: string;
  budget: string;
  mandatory: string;
  preferences: string;
  condition: Condition;
  deadline: string;
  deadlineKind: DeadlineKind;
}

export const BLANK_FORM: RequestFormState = {
  title: "",
  purpose: "",
  itemName: "",
  quantity: "1",
  unit: "units",
  budget: "",
  mandatory: "",
  preferences: "",
  condition: "new",
  deadline: "",
  deadlineKind: "flexible",
};

/** Today's calendar date in `timeZone`, plus `days`, as YYYY-MM-DD. Computed when the example is loaded. */
export function dateInZone(days: number, timeZone: string, now: Date = new Date()): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return t.toISOString().slice(0, 10);
}

/** Dollars text for an integer-cents budget ("100", "1000", "12.50"). */
export function centsToDollarsText(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function presetToForm(p: ScenarioPreset, timeZone: string, now: Date = new Date()): RequestFormState {
  return {
    title: p.title,
    purpose: p.purpose,
    itemName: p.item,
    quantity: String(p.quantity),
    unit: p.unit,
    budget: centsToDollarsText(p.budgetCents),
    mandatory: p.mandatory.join("\n"),
    preferences: p.preferences.join("\n"),
    condition: p.condition,
    deadline: dateInZone(p.deadlineDays, timeZone, now),
    deadlineKind: p.deadlineType === "hard" ? "hard" : "flexible",
  };
}

/** True when the form differs from what was last loaded (blank, or an example). */
export function isDirty(form: RequestFormState, baseline: RequestFormState): boolean {
  return (Object.keys(baseline) as (keyof RequestFormState)[]).some((k) => form[k].trim() !== baseline[k].trim());
}
