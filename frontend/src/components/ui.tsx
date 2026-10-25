"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, Eligibility, FindingStatus } from "@/lib/api";

export function Page({ children }: { children: React.ReactNode }) {
  return <div className="px-5 pb-10 pt-5">{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  back,
}: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-6">
      {back && (
        <Link href={back.href} className="mb-3 inline-block text-[15px] font-medium text-accent">
          ← {back.label}
        </Link>
      )}
      <h1 className="text-[26px] font-bold leading-[1.2]">{title}</h1>
      {subtitle && <p className="mt-1 text-[14px] text-muted">{subtitle}</p>}
    </header>
  );
}

export function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-rule py-5">
      {title && <h2 className="mb-3 text-[18px] font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "quiet" }) {
  const base = "h-12 w-full rounded-lg text-[16px] font-semibold disabled:opacity-40";
  const styles =
    variant === "primary"
      ? "bg-accent text-white active:bg-accent-press"
      : "bg-raised text-ink active:bg-group";
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
    <div className="mb-5">
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
  "block w-full rounded-md border border-rule bg-raised px-3 py-3 text-[16px] text-ink placeholder:text-muted/70 focus:border-accent focus:bg-paper aria-[invalid=true]:border-bad";

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
    <div role="radiogroup" aria-label={label} className="flex overflow-hidden rounded-lg border border-rule">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`h-11 flex-auto whitespace-nowrap px-1 text-[14px] ${i > 0 ? "border-l border-rule" : ""} ${
            value === o.value ? "bg-accent-soft font-semibold text-accent" : "bg-raised text-ink"
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
    <div role="alert" className="my-4 border-l-2 border-bad pl-3 text-[14px]">
      <p className="text-bad">{error.message}</p>
      <p className="mt-0.5 text-[13px] text-muted">
        Code: {error.code}
        {error.requestId && ` · Trace: ${error.requestId}`}
      </p>
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
    <div className="border-t border-rule py-8">
      <p className="text-[18px] font-semibold">{title}</p>
      <p className="mt-1 text-[14px] text-muted">{body}</p>
    </div>
  );
}

const finding: Record<FindingStatus, { glyph: string; label: string; cls: string }> = {
  supported: { glyph: "✓", label: "Supported", cls: "text-ok" },
  contradicted: { glyph: "✕", label: "Contradicted", cls: "text-bad" },
  unknown: { glyph: "?", label: "Unknown", cls: "text-warn" },
};
export function FindingMark({ status }: { status: FindingStatus }) {
  const f = finding[status];
  return (
    <span className={`${f.cls} whitespace-nowrap text-[14px] font-medium`}>
      <span aria-hidden>{f.glyph} </span>
      {f.label}
    </span>
  );
}

const elig: Record<Eligibility, { label: string; cls: string }> = {
  eligible: { label: "Eligible", cls: "text-ok" },
  needs_review: { label: "Needs review", cls: "text-warn" },
  rejected: { label: "Rejected", cls: "text-bad" },
};
export function EligibilityMark({ value }: { value: Eligibility }) {
  return <span className={`${elig[value].cls} shrink-0 whitespace-nowrap text-[14px] font-medium`}>{elig[value].label}</span>;
}

export function KeyValue({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="py-1.5">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-[15px] text-muted">{label}</dt>
        <dd className="text-right text-[16px] tabular-nums">{value}</dd>
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
  return { data, error, loading, reload, setData };
}
