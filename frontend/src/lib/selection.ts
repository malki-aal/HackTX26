// Per-request offer choices, kept in this browser tab only until a proposal is submitted.
// The server stays authoritative: it re-validates every selection on submit.

const key = (requestId: string) => `runway.selection.${requestId}`;

export function readSelection(requestId: string): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(key(requestId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function writeSelection(requestId: string, selection: Record<string, string>) {
  try {
    window.sessionStorage.setItem(key(requestId), JSON.stringify(selection));
  } catch {}
}

export function selectionQuery(selection: Record<string, string>): string {
  return Object.entries(selection)
    .map(([item, offer]) => `${item}:${offer}`)
    .join(",");
}

export function parseSelectionQuery(q: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (q ?? "").split(",")) {
    const [item, offer] = part.split(":");
    if (item && offer) out[item] = offer;
  }
  return out;
}
