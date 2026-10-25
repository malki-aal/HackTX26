"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { api, type ApiError, type Wallet, type WalletEntry } from "@/lib/api";
import { newIdempotencyKey } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { Button, ErrorNote, Loading, formatWhen, normalizeError, useLoad, usePolling } from "@/components/ui";

const STATUS_NOTE: Record<string, string> = {
  queued: "Pending",
  submitting: "In progress",
  uncertain: "Checking",
  failed: "Didn’t go through",
};

/**
 * Pay the seller from the money an approval sent to this employee. Two taps: choose, then confirm.
 * The same idempotency key is reused if the request is retried, so it can never pay twice.
 */
export function PayButton({ executionId, seller, amountCents, onPaid }: { executionId: string; seller: string | null; amountCents: number; onPaid: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const keyRef = useRef<string | null>(null);
  const who = seller ?? "the seller";

  async function pay() {
    if (pending) return;
    keyRef.current ??= newIdempotencyKey();
    setPending(true);
    setError(null);
    try {
      await api.payExecution(executionId, keyRef.current);
      setConfirming(false);
      onPaid();
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <div className="mt-2">
        <Button onClick={() => setConfirming(true)}>Pay {who} {formatCents(amountCents)}</Button>
      </div>
    );
  }
  return (
    <div className="mt-2 rounded-xl bg-raised p-3">
      <p className="text-[14px]">
        Pay {who} <span className="font-semibold tabular-nums">{formatCents(amountCents)}</span> from your Runway account? This records a simulated purchase in the
        Nessie sandbox. No real order is placed.
      </p>
      <ErrorNote error={error} />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={pending} onClick={pay} className="rounded-full bg-accent px-4 py-2 text-[15px] font-semibold text-white disabled:opacity-60">
          {pending ? "Paying…" : "Confirm payment"}
        </button>
        <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="rounded-full bg-paper px-4 py-2 text-[15px] font-semibold">
          Cancel
        </button>
      </div>
    </div>
  );
}

function Row({ e, onChange }: { e: WalletEntry; onChange: () => void }) {
  const received = e.type === "received";
  const note = STATUS_NOTE[e.status];
  return (
    <li className="border-t border-rule py-3 first:border-t-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[16px]">
          {received ? `Received · ${e.title ?? "Approved request"}` : `Paid ${e.seller ?? "seller"}`}
        </span>
        {/* Sign and words carry the meaning too, not colour alone. */}
        <span className={`shrink-0 text-[16px] font-semibold tabular-nums ${note ? "text-muted" : received ? "text-ok" : "text-bad"}`}>
          {received ? "+" : "−"}
          {formatCents(e.amountCents)}
        </span>
      </div>
      <p className="text-[13px] text-muted">
        {received ? "From the company, approved" : "Simulated purchase"}
        {e.at ? ` · ${formatWhen(e.at)}` : ""}
        {note ? ` · ${note}` : ""}
        {e.requestId && (
          <>
            {" · "}
            <Link href={`/requests/${e.requestId}/proposal`} className="font-medium text-accent">Details</Link>
          </>
        )}
      </p>
      {received && e.canPay && <PayButton executionId={e.executionId} seller={e.seller} amountCents={e.amountCents} onPaid={onChange} />}
    </li>
  );
}

/** The employee's Runway account: approvals arrive as +, payments to sellers leave as −. */
export function WalletCard({ limit }: { limit?: number }) {
  const w = useLoad<Wallet>(() => api.getWallet(), []);
  usePolling(w.refresh, 5000);
  const data = w.data;
  const entries = data ? (limit ? data.entries.slice(0, limit) : data.entries) : [];
  return (
    <section aria-labelledby="wallet-title" className="mb-4 rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)]">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="wallet-title" className="text-[17px] font-semibold">Your Runway account</h2>
        {data?.account?.masked && <span className="text-[13px] text-muted">{data.account.masked}</span>}
      </div>
      {w.loading && <Loading />}
      <ErrorNote error={w.error} onRetry={w.reload} />
      {data && (
        <>
          <p className="mt-1 text-[28px] font-bold tabular-nums leading-tight">{formatCents(data.runwayBalanceCents)}</p>
          <p className="text-[13px] text-muted">
            Received {formatCents(data.receivedCents)} · Paid {formatCents(data.paidCents)}
            {data.reportedBalanceCents !== null && data.reportedBalanceCents !== data.runwayBalanceCents && ` · Nessie reports ${formatCents(data.reportedBalanceCents)}`}
          </p>
          {entries.length === 0 ? (
            <p className="mt-3 text-[14px] text-muted">When an executive approves your request, the money arrives here. Then you pay the seller.</p>
          ) : (
            <ul className="mt-2">{entries.map((e) => <Row key={`${e.type}-${e.executionId}`} e={e} onChange={() => void w.refresh()} />)}</ul>
          )}
          <p className="mt-2 text-[12px] text-muted">{data.disclaimer}</p>
        </>
      )}
    </section>
  );
}
