// Small fetch wrapper: timeouts, bounded retries for safe reads only, and redacted errors.
import { IntegrationError } from "./errors.js";
import { redactUrl, scrub } from "./redact.js";

type Service = IntegrationError["service"];

export interface HttpRequest {
  service: Service;
  method: "GET" | "POST" | "PUT";
  url: string;
  body?: unknown;
  timeoutMs: number;
  /** Retries apply to GET only. Writes are never retried here. */
  retries?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  body: unknown;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest Retry-After a safe read will wait out before giving up and surfacing the limit. */
export const RETRY_AFTER_MAX_SECONDS = 5;

/** Parse Retry-After (delta-seconds or HTTP-date) into whole seconds; null when absent/invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.ceil((t - now) / 1000));
}

/**
 * Reads retry with bounded exponential backoff; a rate limit is retried only when the provider's
 * Retry-After is short. Writes are never retried here.
 */
export async function httpJson(req: HttpRequest): Promise<HttpResponse> {
  const attempts = req.method === "GET" ? 1 + (req.retries ?? 2) : 1;
  let lastErr: IntegrationError | null = null;
  let wait = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(wait || 250 * 2 ** (i - 1));
    wait = 0;
    try {
      return await once(req);
    } catch (e) {
      if (!(e instanceof IntegrationError)) throw e;
      lastErr = e;
      if (!e.retryable || req.signal?.aborted) break;
      if (e.code === "UPSTREAM_RATE_LIMITED") {
        const ra = e.details.retryAfterSeconds as number | null | undefined;
        if (ra === null || ra === undefined || ra > RETRY_AFTER_MAX_SECONDS) break;
        wait = ra * 1000;
      }
    }
  }
  throw lastErr!;
}

async function once(req: HttpRequest): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const isWrite = req.method !== "GET";
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal,
    });
  } catch (e) {
    const timedOut = timeout.aborted;
    const cancelled = req.signal?.aborted ?? false;
    const msg = `${req.service} ${req.method} ${redactUrl(new URL(req.url).pathname)} ${timedOut ? "timed out" : cancelled ? "was cancelled" : "network error"}`;
    // A write that may have reached the server is ambiguous.
    throw new IntegrationError(req.service, timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR", msg, isWrite ? "ambiguous" : "definitive", !cancelled && !isWrite);
  }
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.status === 429) {
    const retryAfterSeconds = parseRetryAfter(res.headers.get("retry-after"));
    const message = typeof body === "object" && body ? String((body as { error?: unknown }).error ?? "") : String(body ?? "");
    // SerpApi uses 429 both for hourly throughput limits and for an exhausted monthly plan.
    const quotaExhausted = /run out of searches|out of searches|quota/i.test(message);
    throw new IntegrationError(
      req.service,
      "UPSTREAM_RATE_LIMITED",
      quotaExhausted
        ? `${req.service} quota exhausted: the account has no searches left`
        : `${req.service} rate limited${retryAfterSeconds !== null ? `; retry after ${retryAfterSeconds}s` : ""}`,
      "definitive",
      !quotaExhausted,
      429,
      { kind: quotaExhausted ? "quota_exhausted" : "rate_limited", retryAfterSeconds },
    );
  }
  if (res.status >= 500) {
    throw new IntegrationError(req.service, "UPSTREAM_ERROR", `${req.service} returned HTTP ${res.status}`, isWrite ? "ambiguous" : "definitive", !isWrite, res.status);
  }
  return { status: res.status, body, text: scrub(text).slice(0, 2000) };
}
