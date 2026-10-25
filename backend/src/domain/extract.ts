// Deterministic attribute extraction from listing text. Each extractor returns the matched
// excerpt so the value can be cited as evidence. Patterns are deliberately token-bounded so
// that "1440p" is never confused with "1080p", "144Hz" is never read as a resolution, and
// "HDMI" is never read as "USB-C".
import type { Condition } from "./types.js";

export interface Match<T> {
  value: T;
  excerpt: string;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
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

const ACCESSORY_RE =
  /\b(?:mount|arm|stand only|desk stand|riser|bracket|cable|cord|adapter|dongle|hub|docking station|screen protector|privacy (?:filter|screen)|anti[\s-]?glare film|cover|dust cover|case|bag|hood|replacement|parts?|(?:button|power|main|control|logic|t-?con|driver|controller)\s?board|mainboard|power supply|remote|light bar|cleaning kit|wall plate)\b/i;
const MONITOR_RE = /\b(?:monitor|display|screen)\b/i;
// Phrases that describe a feature of a monitor rather than a separate accessory.
const FEATURE_PHRASES = [
  /\b(?:with|w\/|includes?|including|adjustable|height[\s-]?adjustable|built[\s-]?in)\s+(?:[\w-]+\s+){0,3}(?:stand|cable|cables|hub|speakers?|mount)\b/gi,
  /\b(?:vesa|wall)[\s-]?(?:mount(?:able|ing)?|compatible)(?:[\s-]?(?:ready|compatible))?\b/gi,
  /\bmount(?:ing)?[\s-]?(?:ready|compatible)\b/gi,
];

/**
 * Classify whether a listing is a monitor or an accessory/part. "Monitor Arm", "HDMI Cable for
 * 27-inch Monitor" and "Monitor ... Button Board" are not monitors even though they mention one;
 * "Monitor with built-in USB hub" and "VESA Wall Mount Ready" are monitor features.
 */
export function extractProductType(text: string): Match<"monitor" | "accessory"> | null {
  let stripped = text;
  for (const re of FEATURE_PHRASES) stripped = stripped.replace(re, (m) => " ".repeat(m.length));
  const acc = ACCESSORY_RE.exec(stripped);
  if (acc) return { value: "accessory", excerpt: excerptAround(text, acc.index, acc[0].length) };
  const mon = MONITOR_RE.exec(text);
  if (mon) return { value: "monitor", excerpt: excerptAround(text, mon.index, mon[0].length) };
  return null;
}

export function extractPackageQuantity(text: string): Match<number> | { ambiguous: string } | null {
  const pack = /\b(?:(\d{1,3})\s*-?\s*(?:pack|pk|count|ct)\b|pack\s+of\s+(\d{1,3})|set\s+of\s+(\d{1,3})|(\d{1,2})\s*x\s+(?=\d{2}(?:\.\d)?\s*(?:"|-?\s*inch)))/i.exec(text);
  if (pack) {
    const n = Number(pack[1] ?? pack[2] ?? pack[3] ?? pack[4]);
    if (n >= 1 && n <= 500) return { value: n, excerpt: excerptAround(text, pack.index, pack[0].length) };
  }
  const ambiguous = /\b(?:bundle|lot of|dual monitor|triple monitor|kit)\b/i.exec(text);
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
