import type { RequestItem } from "./api";

/** "4 units Monitors" style text built only from the request's own items. */
export function itemLine(item: Pick<RequestItem, "name" | "quantity" | "unit">): string {
  return `${item.quantity} ${item.unit} · ${item.name}`;
}

/** One short summary for lists. Never hard-codes a product word. */
export function summarizeItems(items: Pick<RequestItem, "name" | "quantity" | "unit">[]): string {
  if (items.length === 0) return "No items";
  if (items.length === 1) return `${items[0].quantity} × ${items[0].name}`;
  return `${items.length} items`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** RFC 4122 v4 id. crypto.randomUUID needs a secure context, which a phone on a LAN address is not. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
