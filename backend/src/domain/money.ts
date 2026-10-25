// Integer-cent money helpers. Never use floating point arithmetic on amounts.

export type Currency = "USD";

export interface ParsedPrice {
  currency: Currency | null;
  cents: number | null;
  /** Raw currency symbol/code found, used to reject mixed currencies. */
  currencyToken: string | null;
}

const CURRENCY_TOKENS: Record<string, Currency | null> = {
  $: "USD",
  US$: "USD",
  USD: "USD",
  "€": null,
  EUR: null,
  "£": null,
  GBP: null,
  "¥": null,
  JPY: null,
  CA$: null,
  CAD: null,
  C$: null,
  A$: null,
  AUD: null,
  "₹": null,
  INR: null,
};

/**
 * Parse a decimal amount string such as "1,299.99" or "45" into integer cents.
 * Returns null for anything that is not a plain non-negative decimal with at most two fractional digits.
 */
export function decimalStringToCents(input: string): number | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Parse a display price such as "$1,299.99", "US$45", "€30.00". */
export function parsePriceText(text: string | null | undefined): ParsedPrice {
  if (!text) return { currency: null, cents: null, currencyToken: null };
  const t = text.trim();
  const m = /^(US\$|CA\$|C\$|A\$|\$|€|£|¥|₹|USD|EUR|GBP|JPY|CAD|AUD|INR)?\s*([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP|JPY|CAD|AUD|INR)?/i.exec(t);
  if (!m) return { currency: null, cents: null, currencyToken: null };
  const token = (m[1] ?? m[3] ?? "").toUpperCase() || null;
  const normalizedToken = token === "US$" ? "US$" : token;
  const currency = normalizedToken && normalizedToken in CURRENCY_TOKENS ? CURRENCY_TOKENS[normalizedToken] ?? null : null;
  return { currency, cents: decimalStringToCents(m[2]!), currencyToken: normalizedToken };
}

/** Convert a provider float (e.g. SerpApi extracted_price 5.88) into cents via its decimal string form. */
export function floatToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return decimalStringToCents(value.toFixed(2));
}

export function centsToDecimalString(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("cents must be a safe integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatUsd(cents: number): string {
  const [whole, frac] = centsToDecimalString(cents).split(".");
  return `$${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

export function addCents(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error("non-integer cents");
    total += v;
  }
  if (!Number.isSafeInteger(total)) throw new Error("cents overflow");
  return total;
}

export function multiplyCents(cents: number, factor: number): number {
  if (!Number.isSafeInteger(cents) || !Number.isSafeInteger(factor)) throw new Error("non-integer operand");
  const r = cents * factor;
  if (!Number.isSafeInteger(r)) throw new Error("cents overflow");
  return r;
}
