"use client";

import Link from "next/link";
import { Children, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import { ProfileMenu } from "@/components/profile-menu";
import { api, type ApiError, type BackendMode, type Eligibility, type FindingStatus } from "@/lib/api";

let modePromise: Promise<BackendMode> | null = null;
function backendMode(): Promise<BackendMode> {
  modePromise ??= api.getBackendMode();
  return modePromise;
}

/** Shown only when the data is not live: sample data or an unreachable backend. */
export function DataNote() {
  const [mode, setMode] = useState<BackendMode | null>(null);
  useEffect(() => {
    let alive = true;
    void backendMode().then((m) => alive && setMode(m));
    return () => {
      alive = false;
    };
  }, []);
  if (mode === "offline") return <p role="alert" className="no-print mb-2 text-[13px] font-semibold text-white">Backend unreachable</p>;
  if (mode === "fixtures" || api.mode === "fixture")
    return <p className="no-print mb-2 text-[13px] font-medium text-white/80">Sample data. Nothing here is real.</p>;
  return null;
}

/** Where financial records appear. */
export function SandboxNote() {
  return <p className="mt-2 text-[13px] text-muted">Nessie sandbox: simulated banking records. No real money moves.</p>;
}

// ---------- hero ----------

/** Dollars in bold, cents lighter. */
export function Amount({ cents, className = "" }: { cents: number | null | undefined; className?: string }) {
  if (cents == null) return <span className={className}>Unknown</span>;
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  const rest = String(cents % 100).padStart(2, "0");
  return (
    <span className={`tabular-nums ${className}`}>
      ${dollars}
      <span className="opacity-75">.{rest}</span>
    </span>
  );
}

export interface HeroStat {
  label: string;
  value: React.ReactNode;
}

/**
 * Blue header band. A page puts one PageHeader among its children; Page lifts it above the sheet.
 * Optional `amount` (cents) is the screen's one big number; `stats` are up to three small facts.
 */
export function PageHeader({
  title,
  back,
  amount,
  amountLabel,
  amountNote,
  stats,
  children,
}: {
  title: string;
  /** Kept for call sites; shown as small text under the title. */
  subtitle?: string;
  back?: { href: string; label: string };
  amount?: number | null;
  amountLabel?: string;
  amountNote?: React.ReactNode;
  stats?: HeroStat[];
  children?: React.ReactNode;
}) {
  return (
    <header className="relative bg-hero px-5 pb-12 text-white" style={{ paddingTop: "calc(env(safe-area-inset-top) + 16px)" }}>
      <ProfileMenu />
      <DataNote />
      {back && (
        <Link
          href={back.href}
          aria-label={`Back to ${back.label}`}
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-hero-tile text-[20px] font-medium text-white"
        >
          <span aria-hidden>‹</span>
        </Link>
      )}
      <h1 className="pr-12 text-[26px] font-bold leading-[1.2]">{title}</h1>
      {amount !== undefined && (
        <div className="mt-4">
          {amountLabel && <p className="text-[14px] text-white/85">{amountLabel}</p>}
          <p className="text-[40px] font-bold leading-[1.1]">
            <Amount cents={amount} />
          </p>
          {amountNote && <p className="mt-1 text-[14px] text-white/85">{amountNote}</p>}
        </div>
      )}
      {stats && stats.length > 0 && (
        <dl className="mt-5 grid gap-2" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
          {stats.map((s) => (
            <div key={s.label} className="rounded-xl bg-hero-tile px-3 py-2.5">
              <dt className="text-[12px] text-white/85">{s.label}</dt>
              <dd className="mt-0.5 text-[17px] font-bold leading-tight tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {children}
    </header>
  );
}

/** Thin bar for "this much of that". The amount text always sits beside it. */
export function ProgressBar({ value, max, over }: { value: number; max: number; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-hero-tile" aria-hidden>
      <div className={`h-full rounded-full ${over ? "bg-orange-bar" : "bg-white"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Page({ children }: { children: React.ReactNode }) {
  const all = Children.toArray(children);
  const hero = all.find((c) => isValidElement(c) && c.type === PageHeader);
  const rest = all.filter((c) => c !== hero);
  return (
    <div className="flex min-h-full flex-col bg-hero">
      {hero}
      <div className="relative -mt-7 flex-1 rounded-t-[28px] bg-canvas px-4 pb-10 pt-5">{rest}</div>
    </div>
  );
}

/** A white card. Lists inside it use dividers, never nested cards. */
export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-4 rounded-2xl bg-paper p-5 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)]">
      {title && <h2 className="mb-3 text-[18px] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" }) {
  const base = "h-[52px] w-full rounded-xl text-[16px] font-semibold disabled:opacity-40";
  const styles =
    variant === "primary"
      ? "bg-accent text-white active:bg-accent-press"
      : "bg-accent-soft text-accent active:bg-accent-soft-press";
  return <button {...props} className={`${base} ${styles} ${props.className ?? ""}`} />;
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
}: {
  required?: boolean;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="mb-5 last:mb-0">
      <label htmlFor={htmlFor} className="mb-1.5 block text-[15px] font-medium">
        {label}
        {required && <RequiredMark />}
      </label>
      {children}
      {hint && !error && <p className="mt-1.5 text-[13px] text-muted">{hint}</p>}
      {error && (
        <p id={`${htmlFor}-error`} role="alert" className="mt-1.5 text-[13px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

export function RequiredMark() {
  return (
    <>
      <span aria-hidden className="ml-0.5 text-bad">*</span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

export const inputClass =
  "block w-full rounded-xl border border-rule bg-raised px-3.5 py-3 text-[16px] text-ink placeholder:text-muted/70 focus:border-accent focus:bg-paper aria-[invalid=true]:border-bad";

/** Pill track with a white thumb on the chosen option. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-full bg-track p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-10 flex-auto whitespace-nowrap rounded-full px-2 text-[14px] ${
            value === o.value
              ? "bg-paper font-semibold text-accent shadow-[0_1px_3px_rgba(16,24,40,0.15)]"
              : "font-medium text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="my-4 rounded-xl border-l-4 border-bad bg-bad-soft p-3 text-[14px]">
      <p className="text-bad">{error.message}</p>
      <details className="mt-1 text-[12px] text-muted">
        <summary className="cursor-pointer">Technical details</summary>
        {error.code}{error.requestId && ` · ${error.requestId}`}
      </details>
      {onRetry && (
        <button onClick={onRetry} className="mt-1 text-[15px] font-medium text-accent">
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p role="status" className="py-6 text-[15px] text-muted">
      {label}…
    </p>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-4 rounded-2xl bg-paper p-6 text-center shadow-[0_1px_2px_rgba(16,24,40,0.06)]">
      <p className="text-[18px] font-semibold">{title}</p>
      <p className="mt-1 text-[14px] text-muted">{body}</p>
    </div>
  );
}

const finding: Record<FindingStatus, { glyph: string; label: string; cls: string }> = {
  supported: { glyph: "✓", label: "Supported", cls: "bg-green-soft text-green-ink" },
  contradicted: { glyph: "✕", label: "Contradicted", cls: "bg-bad-soft text-bad" },
  unknown: { glyph: "?", label: "Unknown", cls: "bg-orange-soft text-orange-ink" },
};
export function FindingMark({ status }: { status: FindingStatus }) {
  const f = finding[status];
  return (
    <span className={`${f.cls} shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium`}>
      <span aria-hidden>{f.glyph} </span>
      {f.label}
    </span>
  );
}

const elig: Record<Eligibility, { label: string; cls: string }> = {
  eligible: { label: "Eligible", cls: "bg-green-soft text-green-ink" },
  needs_review: { label: "Needs review", cls: "bg-orange-soft text-orange-ink" },
  rejected: { label: "Rejected", cls: "bg-bad-soft text-bad" },
};
export function EligibilityMark({ value }: { value: Eligibility }) {
  return (
    <span className={`${elig[value].cls} shrink-0 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium`}>
      {elig[value].label}
    </span>
  );
}

export function KeyValue({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-[15px] text-muted">{label}</dt>
        <dd className="text-right text-[16px] font-medium tabular-nums">{value}</dd>
      </div>
      {note && <p className="mt-0.5 text-[13px] text-muted">{note}</p>}
    </div>
  );
}

export function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function normalizeError(e: unknown): ApiError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as ApiError;
  return { code: "network_error", message: "Something went wrong. Check your connection and try again." };
}

// Loads on mount and when deps change; exposes reload. Reads only; never
// starts paid work. State is set only after the awaited call resolves.
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const key = deps.map(String).join("|");

  useEffect(() => {
    let cancelled = false;
    fnRef
      .current()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(normalizeError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const reload = useCallback(async () => setTick((t) => t + 1), []);

  // Quiet re-read for polling: no loading flash, never overlaps itself.
  const inflight = useRef(false);
  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      inflight.current = false;
    }
  }, []);

  return { data, error, loading, reload, refresh, setData };
}

/**
 * Calls `tick` about every `ms` while the page is visible, one call at a time. Hidden tabs pause and
 * refresh as soon as they return. It only ever runs read calls the caller passes in; it never mutates.
 */
export function usePolling(tick: () => Promise<unknown>, ms = 5000, enabled = true) {
  const tickRef = useRef(tick);
  useEffect(() => {
    tickRef.current = tick;
  });
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      if (stopped) return;
      if (!document.hidden) await tickRef.current();
      if (!stopped) timer = setTimeout(loop, ms);
    };
    const onVisible = () => {
      if (!document.hidden && !stopped) {
        clearTimeout(timer);
        void loop();
      }
    };
    timer = setTimeout(loop, ms);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ms, enabled]);
}
