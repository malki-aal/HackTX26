// Model-written shortlist wording, accepted only when it stays inside the computed facts.
// The model may reword a label and the explanation of an entry; it may not add numbers, dates,
// offers or claims the backend did not compute. Anything that fails a check falls back to the
// deterministic wording for that entry, so results never depend on the model.
import type { Shortlist, ShortlistEntry } from "./shortlist.js";

export interface ShortlistNote {
  offerId: string;
  label: string;
  why: string;
  drawback: string;
  unverified?: string[];
}

export interface NoteVerdict {
  offerId: string;
  accepted: boolean;
  reason: string | null;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const numbers = (s: string) => [...s.matchAll(NUMBER)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));

/** Phrases that claim more than evaluated evidence can support, whatever the facts say. */
const ALWAYS_UNSUPPORTED: Array<[RegExp, string]> = [
  [/\bguarantee/i, "guarantees"],
  [/\b(?:better|higher|superior|premium|top)[\s-](?:quality|built|made|grade)\b/i, "quality claims"],
  [/\bwill arrive\b|\barrives?\s+(?:on time|in time)\b|\bconfirmed\s+(?:delivery|arrival)\b|\bdelivered\s+by\b/i, "confirmed arrival"],
  [/\bfree shipping means\b|\bships? free so\b/i, "timeliness from free shipping"],
];

/** Every number in the backend's own wording and facts for this entry. */
function allowedNumbers(entry: ShortlistEntry): Set<number> {
  const text = [entry.label, entry.status, entry.explanation, entry.compromise, ...entry.unverified, JSON.stringify(entry.facts)].join(" ");
  const set = new Set(numbers(text));
  // Cents in the facts may be written as dollars.
  for (const c of [entry.facts.knownCostCents, entry.facts.budgetCents, entry.facts.overBudgetCents, entry.facts.costVsClosestCents]) {
    if (c !== null && c !== undefined) {
      set.add(Math.abs(c) / 100);
      set.add(Math.round(Math.abs(c) / 100));
    }
  }
  return set;
}

export function checkNote(note: ShortlistNote, entry: ShortlistEntry | undefined, opts: { locationSet: boolean }): string | null {
  if (!entry) return "offerId is not on the shortlist";
  const words = note.label.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5 || note.label.length > 40) return "label must be 1–5 words";
  if (!note.why.trim() || note.why.length > 240) return "explanation missing or too long";
  if (!note.drawback.trim() || note.drawback.length > 200) return "drawback missing or too long";
  const text = [note.label, note.why, note.drawback, ...(note.unverified ?? [])].join(" ");
  const allowed = allowedNumbers(entry);
  const stray = numbers(text).find((n) => !allowed.has(n));
  if (stray !== undefined) return `number ${stray} is not in the computed facts`;
  for (const [re, what] of ALWAYS_UNSUPPORTED) if (re.test(text)) return `unsupported claim (${what})`;
  const facts = JSON.stringify(entry.facts).toLowerCase();
  if (/\b(?:nsf|etl|ul[\s-]listed|certified|certification)\b/i.test(text) && !/\b(?:nsf|etl|certif)/.test(facts)) return "unsupported certification claim";
  if (entry.compliance !== "meets_all" && /\b(?:meets|satisfies)\s+(?:all|every)\b|\bfully\s+(?:meets|compliant)\b|\bverified match\b/i.test(text)) return "claims every requirement is met";
  if (entry.compliance === "fails_must_have" && /\bmatch\b/i.test(note.label)) return "a failed must-have cannot be labelled a match";
  if (entry.compliance === "over_budget" && !/budget|over|more/i.test(`${note.why} ${note.drawback}`)) return "over-budget option must say it exceeds the budget";
  const conditionUnknown = entry.facts.mustHaves.some((m) => /condition/.test(m.requirement) && m.state !== "supported");
  if (conditionUnknown && /\b(?:brand[\s-]new|is new|confirmed new|new condition (?:is )?confirmed)\b/i.test(text)) return "condition is not confirmed";
  if (!opts.locationSet && /\b(?:arrives|arriving|delivers|delivery)\s+(?:by|before|on)\b/i.test(text) && !/estimate/i.test(text)) return "a delivery estimate must be called an estimate";
  return null;
}

/** Apply validated notes to a shortlist; entries without an accepted note keep deterministic wording. */
export function applyNotes(list: Shortlist, notes: ShortlistNote[], opts: { locationSet: boolean }): { shortlist: Shortlist; verdicts: NoteVerdict[] } {
  const verdicts: NoteVerdict[] = [];
  const byId = new Map(list.entries.map((e) => [e.offerId, e]));
  const accepted = new Map<string, ShortlistNote>();
  for (const n of notes.slice(0, 8)) {
    const why = checkNote(n, byId.get(n.offerId), opts);
    if (!why && accepted.has(n.offerId)) {
      verdicts.push({ offerId: n.offerId, accepted: false, reason: "duplicate note" });
      continue;
    }
    verdicts.push({ offerId: n.offerId, accepted: !why, reason: why });
    if (!why) accepted.set(n.offerId, n);
  }
  const entries = list.entries.map((e) => {
    const n = accepted.get(e.offerId);
    if (!n) return e;
    const unverified = (n.unverified ?? []).map((u) => u.trim()).filter((u) => u && u.length <= 160).slice(0, 4);
    return { ...e, label: n.label.trim(), explanation: n.why.trim(), compromise: n.drawback.trim(), unverified: unverified.length ? unverified : e.unverified, source: "model" as const };
  });
  return { shortlist: { ...list, entries }, verdicts };
}
