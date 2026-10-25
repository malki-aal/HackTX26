import type { Offer } from "./api/types";

/** A budget is never an expense. Use only the selected offers and explicitly entered extras. */
export function proposedCost(offers: Pick<Offer, "listedSubtotalCents" | "shippingCents">[], extrasCents = 0): number | null {
  if (!offers.length || !Number.isSafeInteger(extrasCents) || extrasCents < 0) return null;
  if (offers.some((o) => o.listedSubtotalCents === null)) return null;
  const total = offers.reduce((sum, o) => sum + o.listedSubtotalCents! + (o.shippingCents ?? 0), extrasCents);
  return Number.isSafeInteger(total) ? total : null;
}
