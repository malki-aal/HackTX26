// Deterministic attribute extraction from listing text. Each extractor returns the matched
// excerpt so the value can be cited as evidence. Patterns are deliberately token-bounded so
// that "1440p" is never confused with "1080p", "144Hz" is never read as a resolution, and
// "HDMI" is never read as "USB-C".
import type { Condition } from "./types.js";
import { checkListingCategory, getCategory } from "./categories.js";

export interface Match<T> {
  value: T;
  excerpt: string;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

/** True when the excerpt states a minimum ("at least 27 in", "27 in or larger"). */
export function statesMinimum(excerpt: string): boolean {
  return /\b(?:at\s+least|minimum|min\.?|or\s+(?:larger|bigger|more|above)|and\s+up|\+)\b|\d\s*\+/i.test(excerpt);
}

export function extractScreenSize(text: string): Match<number> | null {
  // 27", 27'', 27″, 27-inch, 27 inch, 27in, 27-in, 27 in.
  const re = /(?<![\d.])(\d{2}(?:\.\d)?)\s*(?:"|''|″|”|-?\s*inch(?:es)?\b|-?\s*in\b\.?)/gi;
  for (const m of text.matchAll(re)) {
    const v = Number(m[1]);
    if (v >= 10 && v <= 100) return { value: v, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

export interface Resolution {
  width: number;
  height: number;
}

const NAMED_RESOLUTIONS: Array<[RegExp, Resolution]> = [
  [/\b(?:8k)\b/i, { width: 7680, height: 4320 }],
  [/\b(?:5k2k)\b/i, { width: 5120, height: 2160 }],
  [/\b(?:5k)\b/i, { width: 5120, height: 2880 }],
  [/\b(?:4k|uhd|2160p)\b/i, { width: 3840, height: 2160 }],
  [/\b(?:uwqhd)\b/i, { width: 3440, height: 1440 }],
  [/\b(?:wqhd|qhd|1440p)\b/i, { width: 2560, height: 1440 }],
  [/\b(?:wuxga|1200p)\b/i, { width: 1920, height: 1200 }],
  [/\b(?:fhd|full\s?hd|1080p)\b/i, { width: 1920, height: 1080 }],
  [/\b(?:720p)\b/i, { width: 1280, height: 720 }],
];

export function extractResolution(text: string): Match<Resolution> | null {
  // Explicit WxH takes precedence over marketing names.
  const explicit = /(?<!\d)(\d{3,4})\s*[x×]\s*(\d{3,4})(?!\d)/i.exec(text);
  if (explicit) {
    const w = Number(explicit[1]);
    const h = Number(explicit[2]);
    if (w >= 640 && h >= 480 && w <= 10240 && h <= 4320) {
      return { value: { width: w, height: h }, excerpt: excerptAround(text, explicit.index, explicit[0].length) };
    }
  }
  for (const [re, res] of NAMED_RESOLUTIONS) {
    const m = re.exec(text);
    if (m) return { value: res, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

export type PortName = "hdmi" | "displayport" | "usb_c" | "thunderbolt" | "vga" | "dvi";

const PORT_PATTERNS: Record<PortName, RegExp> = {
  hdmi: /\bhdmi\b/i,
  displayport: /\b(?:display\s?port|dp\s?1\.[0-9]|mini[\s-]?dp)\b/i,
  usb_c: /\b(?:usb[\s-]?c|usb[\s-]?type[\s-]?c|type[\s-]?c)\b/i,
  thunderbolt: /\bthunderbolt\b/i,
  vga: /\bvga\b/i,
  dvi: /\bdvi(?:-d)?\b/i,
};

export function extractPorts(text: string): Array<Match<PortName>> {
  const out: Array<Match<PortName>> = [];
  for (const [port, re] of Object.entries(PORT_PATTERNS) as Array<[PortName, RegExp]>) {
    const m = re.exec(text);
    if (m) out.push({ value: port, excerpt: excerptAround(text, m.index, m[0].length) });
  }
  return out;
}

export function extractRefreshRate(text: string): Match<number> | null {
  const m = /(?<!\d)(\d{2,3})\s*hz\b/i.exec(text);
  if (!m) return null;
  return { value: Number(m[1]), excerpt: excerptAround(text, m.index, m[0].length) };
}

export function extractPanelType(text: string): Match<"ips" | "va" | "tn" | "oled"> | null {
  const patterns: Array<["ips" | "va" | "tn" | "oled", RegExp]> = [
    ["oled", /\b(?:qd-?)?oled\b/i],
    ["ips", /\bips\b/i],
    ["va", /\bva\b/i],
    ["tn", /\btn\b/i],
  ];
  for (const [v, re] of patterns) {
    const m = re.exec(text);
    if (m) return { value: v, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

export function extractCondition(text: string): Match<Condition> | null {
  const patterns: Array<[Condition, RegExp]> = [
    ["refurbished", /\b(?:refurbished|renewed|reconditioned|open[\s-]?box)\b/i],
    ["used", /\b(?:used|pre-?owned|second[\s-]?hand)\b/i],
    ["new", /\b(?:brand[\s-]?new|new)\b/i],
  ];
  for (const [v, re] of patterns) {
    const m = re.exec(text);
    if (m) return { value: v, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

/**
 * Monitor-or-accessory classification (kept for callers that only deal with monitors). The
 * category registry owns the patterns; see checkListingCategory for the general check.
 */
export function extractProductType(text: string): Match<"monitor" | "accessory"> | null {
  const c = checkListingCategory(text, getCategory("monitors")!);
  if (c.state === "supported") return { value: "monitor", excerpt: c.excerpt ?? text.slice(0, 60) };
  if (c.state === "contradicted" && c.detected === "accessory_or_part") return { value: "accessory", excerpt: c.excerpt ?? text.slice(0, 60) };
  return null;
}

export function extractPackageQuantity(text: string): Match<number> | { ambiguous: string } | null {
  const pack =
    /\b(?:(\d{1,5})\s*-?\s*(?:pack|pk|count|ct|pcs|pieces|piece|pc)\b|(?:pack|box|bag|set|case)\s+of\s+(\d{1,5})|(?:qty|quantity)[:\s]+(\d{1,5})\b|(?<![\d.])([2-9])\s*x\s+(?=\d{2}(?:\.\d)?\s*(?:"|-?\s*inch)))/i.exec(text);
  if (pack) {
    const n = Number(pack[1] ?? pack[2] ?? pack[3] ?? pack[4]);
    if (n >= 1 && n <= 10_000) return { value: n, excerpt: excerptAround(text, pack.index, pack[0].length) };
  }
  const ambiguous = /\b(?:bundle|lot of|dual monitor|triple monitor|kit|assorted|assortment)\b/i.exec(text);
  if (ambiguous) return { ambiguous: excerptAround(text, ambiguous.index, ambiguous[0].length) };
  return null;
}

const KNOWN_BRANDS = [
  "Dell", "LG", "Samsung", "ASUS", "Acer", "HP", "Lenovo", "BenQ", "ViewSonic", "AOC", "MSI", "Gigabyte",
  "Philips", "Sceptre", "Alienware", "Apple", "Sony", "Pixio", "Koorui", "Innocn", "Spectre", "INNOCN",
];

export function extractBrand(text: string): string | null {
  for (const b of KNOWN_BRANDS) {
    if (new RegExp(`\\b${b}\\b`, "i").test(text)) return b;
  }
  return null;
}

export function extractModel(text: string): string | null {
  // Model-number-like tokens: letters followed by digits, at least 5 chars, e.g. S2721DGF, 27GP850-B, VA2759-SMH.
  const m = /\b([A-Z]{1,5}\d{2,}[A-Z0-9-]{1,12}|\d{2}[A-Z]{1,4}\d{2,}[A-Z0-9-]*)\b/.exec(text);
  return m && m[1]!.length >= 5 ? m[1]!.toUpperCase() : null;
}

export function extractInstallmentHint(text: string): boolean {
  return /\/\s?mo\b|per month|monthly|\bmo\.?\s*$|for \d+ mo/i.test(text);
}

// ---------- Material and general-purpose extractors ----------

const FRACTION = String.raw`(\d+\s+\d+\/\d+|\d+\/\d+|\d*\.\d+|\d+)`;

/** Parse "5/8", "1 1/4", "0.625", "2" into a number. */
export function parseMixedNumber(s: string): number | null {
  const t = s.trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) return Number(frac[2]) === 0 ? null : Number(frac[1]) / Number(frac[2]);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const VOLUME_TO_ML: Array<[RegExp, number]> = [
  [/^(?:(?:us\s+)?fl\.?\s*oz\.?|(?:us\s+)?fluid\s+ounces?)$/i, 29.5735],
  [/^(?:ml|milliliters?|millilitres?)$/i, 1],
  [/^(?:l|liters?|litres?)$/i, 1000],
  [/^(?:gal|gallons?)$/i, 3785.41],
  [/^(?:qt|quarts?)$/i, 946.353],
  [/^(?:pt|pints?)$/i, 473.176],
];

/**
 * Liquid volume in millilitres ("8 fl oz", "64 US fluid ounces", "500 ml", "1 gallon"). Rounded to whole ml.
 * A bare "oz" is not a volume: it can be weight (net wt), so it never counts as fluid ounces.
 */
export function extractVolume(text: string, opts: { bareOzIsFluid?: boolean } = {}): Match<number> | null {
  const units = `(?:us\\s+)?fl\\.?\\s*oz\\.?|(?:us\\s+)?fluid\\s+ounces?|ml|milliliters?|millilitres?|l|liters?|litres?|gal|gallons?|qt|quarts?|pt|pints?${opts.bareOzIsFluid ? "|oz|ounces?" : ""}`;
  const re = new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*-?\\s*(${units})(?![a-z])`, "gi");
  for (const m of text.matchAll(re)) {
    const unit = m[2]!.replace(/\s+/g, " ");
    // Container capacity (a blender pitcher) cannot be a weight, so "64 oz" there means fluid ounces.
    const factor = opts.bareOzIsFluid && /^(?:oz|ounces?)$/i.test(unit) ? 29.5735 : VOLUME_TO_ML.find(([u]) => u.test(unit))?.[1];
    if (!factor) continue;
    const ml = Math.round(Number(m[1]) * factor);
    if (ml > 0 && ml < 100_000) return { value: ml, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

const LENGTH_TO_IN: Record<string, number> = { in: 1, inch: 1, inches: 1, '"': 1, "″": 1, ft: 12, feet: 12, foot: 12, mm: 1 / 25.4, cm: 1 / 2.54 };
function lengthUnit(u: string | undefined): number | null {
  if (!u) return null;
  return LENGTH_TO_IN[u.toLowerCase().replace(/\.$/, "")] ?? null;
}

/** Two-dimensional size in inches, e.g. '12" x 12"', '12 x 24 in', '300 x 200 mm', '12 in x 4 ft'. */
export function extractDimensions(text: string): Match<{ length: number; width: number }> | null {
  const unit = String.raw`("|″|in\b|inch(?:es)?\b|ft\b|feet\b|foot\b|mm\b|cm\b)`;
  const re = new RegExp(String.raw`(?<![\d./#])(\d+(?:\.\d+)?)\s*${unit}?\s*[x×]\s*(\d+(?:\.\d+)?)\s*${unit}`, "gi");
  for (const m of text.matchAll(re)) {
    const u2 = lengthUnit(m[4]);
    const u1 = lengthUnit(m[2]) ?? u2;
    if (!u1 || !u2) continue;
    const a = Number(m[1]) * u1;
    const b = Number(m[3]) * u2;
    if (a > 0 && b > 0 && a < 1200 && b < 1200) {
      return { value: { length: Math.round(Math.max(a, b) * 100) / 100, width: Math.round(Math.min(a, b) * 100) / 100 }, excerpt: excerptAround(text, m.index, m[0].length) };
    }
  }
  return null;
}

/** Thickness in inches, e.g. '1/8" thick', '3mm thick', '1/4 inch thickness'. */
export function extractThickness(text: string): Match<number> | null {
  const re = new RegExp(String.raw`${FRACTION}\s*("|″|in\b|inch(?:es)?\b|mm\b|cm\b)\s*(?:-?\s*)?(?:thick(?:ness)?\b)`, "gi");
  const re2 = new RegExp(String.raw`thick(?:ness)?[:\s]+${FRACTION}\s*("|″|in\b|inch(?:es)?\b|mm\b|cm\b)`, "gi");
  for (const m of [...text.matchAll(re), ...text.matchAll(re2)]) {
    const n = parseMixedNumber(m[1]!);
    const u = lengthUnit(m[2]);
    if (n === null || !u) continue;
    const inches = Math.round(n * u * 1000) / 1000;
    if (inches > 0 && inches < 12) return { value: inches, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

/** Screw size as gauge and length in inches, e.g. '#6 x 5/8"', 'No. 8 x 1-1/4 in', '#6 x 0.625 inch'. */
export function extractScrewSize(text: string): Match<{ gauge: number; lengthIn: number }> | null {
  const re = /(?:#|\bno\.?\s*|\bsize\s*)(\d{1,2})\s*[x×]\s*(\d+(?:[-\s]\d+\/\d+)?|\d+\/\d+|\d*\.\d+)\s*("|″|in\b|inch(?:es)?\b)/gi;
  for (const m of text.matchAll(re)) {
    const gauge = Number(m[1]);
    const len = parseMixedNumber(m[2]!.replace("-", " "));
    if (len === null || gauge < 0 || gauge > 24 || len <= 0 || len > 12) continue;
    return { value: { gauge, lengthIn: Math.round(len * 1000) / 1000 }, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthDay(token: string, observed: Date): Date | null {
  const m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})$/i.exec(token.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return null;
  let d = new Date(Date.UTC(observed.getUTCFullYear(), mi, Number(m[2])));
  // Dates earlier than the observation by more than a month refer to next year.
  if (d.getTime() < observed.getTime() - 31 * 86_400_000) d = new Date(Date.UTC(observed.getUTCFullYear() + 1, mi, Number(m[2])));
  return d;
}

/**
 * Latest delivery date a listing states, relative to when it was observed: "Free delivery by Mon",
 * "Free delivery between Oct 27 – Nov 4", "Get it today", "Arrives tomorrow", "Delivery Oct 30".
 * Returns null when no date can be established (unknown stays unknown).
 */
export function extractDeliveryDate(text: string, observedAt: Date): Match<{ latest: string; earliest: string }> | null {
  const obs = new Date(Date.UTC(observedAt.getUTCFullYear(), observedAt.getUTCMonth(), observedAt.getUTCDate()));
  const range = /\bbetween\s+([a-z]{3,9}\.?\s+\d{1,2})\s*[–—-]\s*([a-z]{3,9}\.?\s+\d{1,2}|\d{1,2})\b/i.exec(text);
  if (range) {
    const a = monthDay(range[1]!, obs);
    const bTok = /^\d{1,2}$/.test(range[2]!) ? `${range[1]!.split(/\s+/)[0]} ${range[2]}` : range[2]!;
    const b = monthDay(bTok, obs);
    if (a && b) return { value: { earliest: isoDate(a), latest: isoDate(b) }, excerpt: excerptAround(text, range.index, range[0].length) };
  }
  const by = /\b(?:by|on|arrives?|delivery|get it)\s+(?:by\s+)?([a-z]{3,9}\.?\s+\d{1,2}|today|tomorrow|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/i.exec(text);
  if (by) {
    const tok = by[1]!.toLowerCase();
    let d: Date | null = null;
    if (tok === "today") d = obs;
    else if (tok === "tomorrow") d = new Date(obs.getTime() + 86_400_000);
    else if (WEEKDAYS.includes(tok.slice(0, 3)) && !/\d/.test(tok)) {
      const target = WEEKDAYS.indexOf(tok.slice(0, 3));
      const delta = (target - obs.getUTCDay() + 7) % 7 || 7;
      d = new Date(obs.getTime() + delta * 86_400_000);
    } else d = monthDay(by[1]!, obs);
    if (d) return { value: { earliest: isoDate(d), latest: isoDate(d) }, excerpt: excerptAround(text, by.index, by[0].length) };
  }
  return null;
}

/**
 * Battery capacity in watt-hours ("518 Wh", "1.0 kWh", "500 watt-hours"). Output power in watts ("500W")
 * is a different quantity and never counts as capacity.
 */
export function extractCapacityWh(text: string): Match<number> | null {
  const re = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*-?\s*(kwh|wh|watt[\s-]?hours?|kilowatt[\s-]?hours?)(?![a-z])/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    const wh = /^k/i.test(m[2]!) ? n * 1000 : n;
    if (wh >= 20 && wh <= 50_000) return { value: Math.round(wh), excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };

/** Number of AC outlets ("2 AC outlets", "two 120V AC outlets", "AC outlets x 3", "4x AC"). */
export function extractAcOutlets(text: string): Match<number> | null {
  const num = "(\\d|one|two|three|four|five|six|seven|eight)";
  const res = [
    new RegExp(`\\b${num}\\s*(?:x\\s*)?(?:\\(?\\d{3}\\s*v\\)?\\s*|pure\\s+sine\\s+wave\\s+|standard\\s+)?(?:ac\\s*(?:outlets?|sockets?|ports?|receptacles?))`, "i"),
    new RegExp(`\\bac\\s*(?:outlets?|sockets?|ports?)\\s*(?:x|×|:)\\s*${num}\\b`, "i"),
  ];
  for (const re of res) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = m[1]!.toLowerCase();
    const n = /^\d$/.test(raw) ? Number(raw) : COUNT_WORDS[raw];
    if (n && n >= 1 && n <= 12) return { value: n, excerpt: excerptAround(text, m.index, m[0].length) };
  }
  return null;
}
