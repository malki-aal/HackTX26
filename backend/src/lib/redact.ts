// Remove credentials from URLs and free text before logging, storing or returning them.

const KEY_PARAMS = /([?&](?:key|api_key|apikey|access_token|token)=)[^&#\s"']*/gi;

export function redactUrl(url: string): string {
  return url.replace(KEY_PARAMS, "$1REDACTED");
}

let registeredSecrets: string[] = [];

export function registerSecrets(values: string[]): void {
  registeredSecrets = [...new Set(values.filter((v) => v.length >= 6))];
}

export function scrub(text: string, secrets: string[] = registeredSecrets): string {
  let out = redactUrl(text);
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out;
}

/** Deep-scrub a JSON-compatible value. */
export function scrubValue<T>(value: T, secrets: string[] = registeredSecrets): T {
  if (typeof value === "string") return scrub(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, secrets)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = /^(key|api_?key|token|authorization)$/i.test(k) ? "[REDACTED]" : scrubValue(v, secrets);
    return out as T;
  }
  return value;
}
