"use client";

import type { DecisionState, FinancialPreview, Proposal } from "@/lib/api";
import { personLabel } from "@/lib/api/mappers";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents } from "@/lib/money";
import { formatWhen } from "@/components/ui";

const DECISION_TONE: Record<DecisionState, string> = {
  not_submitted: "bg-raised text-ink",
  awaiting_review: "bg-orange-soft text-orange-ink",
  approved: "bg-green-soft text-green-ink",
  changes_requested: "bg-pink-soft text-pink-ink",
  rejected: "bg-bad-soft text-bad",
};

export function DecisionBadge({ decision }: { decision: DecisionState }) {
  return (
    <span className={`${DECISION_TONE[decision]} inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium`}>
      {DECISION_LABEL[decision]}
    </span>
  );
}

/**
 * A confirmed match and an offer that needs review must never look alike: different words, glyph and
 * outline, not only a different colour.
 */
export function MatchMark({ value }: { value: string }) {
  if (value === "eligible")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-green-soft px-2.5 py-0.5 text-[13px] font-medium text-green-ink">
        <span aria-hidden>✓</span> Confirmed match
      </span>
    );
  if (value === "needs_review")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-orange-ink bg-orange-soft px-2.5 py-0.5 text-[13px] font-semibold text-orange-ink">
        <span aria-hidden>!</span> Needs review
      </span>
    );
  if (value === "rejected")
    return (
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-bad-soft px-2.5 py-0.5 text-[13px] font-medium text-bad">
        <span aria-hidden>✕</span> Fails a must-have
      </span>
    );
  return null;
}

function Figure({ label, cents, note, strong }: { label: string; cents: number | null; note?: string; strong?: boolean }) {
  return (
    <div className="rounded-xl bg-raised px-3 py-2.5">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className={`mt-0.5 tabular-nums leading-tight ${strong ? "text-[20px] font-bold" : "text-[17px] font-semibold"}`}>
        {cents === null ? "Unknown" : formatCents(cents)}
      </dd>
      {note && <p className="mt-0.5 text-[12px] text-muted">{note}</p>}
    </div>
  );
}

/**
 * The four numbers an approver needs, all from the server's financial preview. Nothing is subtracted
 * here: the projected figure is the server's, which never counts a reservation twice.
 */
export function ApprovalSummary({
  p,
  f,
  status,
  onRefresh,
}: {
  p: Proposal;
  f: FinancialPreview | null;
  status: "loading" | "error" | "ready";
  onRefresh: () => void;
}) {
  const projected = f?.projectedAvailableCents ?? null;
  return (
    <section aria-labelledby="summary-title" className="mb-4 rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)]">
      <h2 id="summary-title" className="mb-3 text-[17px] font-semibold">Approval summary</h2>
      <dl className="grid grid-cols-2 gap-2">
        <Figure label="Proposed expense" cents={p.expenseCents} note="Confirmed by the requester" strong />
        <Figure label="Request ceiling" cents={p.budgetCeilingCents} note={p.expenseCents > p.budgetCeilingCents ? "Expense is above it" : undefined} />
        <Figure
          label="Available company budget"
          cents={f ? f.currentAvailableCents : null}
          note={f ? undefined : status === "loading" ? "Checking…" : "Not available"}
        />
        <Figure
          label="After approval"
          cents={projected}
          note={f?.reservationIncluded ? "Already reserved for this proposal" : projected !== null && projected < 0 ? "Below zero" : undefined}
        />
      </dl>
      <p className="mt-2 text-[13px] text-muted">
        {f
          ? `${f.freshness.fetchedAt ? `Bank figures ${f.freshness.refreshedNow ? "refreshed" : "cached"} ${formatWhen(f.freshness.fetchedAt)}.` : "No bank figures yet."} Available budget is Runway’s ledger figure, not the bank balance. `
          : status === "error"
            ? "The budget check is unavailable. "
            : ""}
        <button type="button" className="font-medium text-accent" onClick={onRefresh}>Refresh</button>
      </p>
      {f && f.unknowns.length > 0 && <p className="mt-1 text-[13px] text-muted">Not included: {f.unknowns.join(", ")}.</p>}
    </section>
  );
}

/** The saved decision, worded the same for the requester and the executive. */
export function DecisionRecord({ p }: { p: Proposal }) {
  const a = p.approval;
  const last = p.review?.history[p.review.history.length - 1];
  return (
    <div className="rounded-xl bg-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DecisionBadge decision={p.decision} />
        {a && <span className="text-[13px] text-muted">Saved {formatWhen(a.at)}</span>}
      </div>
      {a && (
        <p className="mt-1.5 text-[14px]">
          By {personLabel(a.actor, "an executive")}
          {last ? ` on revision ${last.version}` : ""}
        </p>
      )}
      {p.decisionNote ? (
        <p className="mt-1.5 text-[16px]">“{p.decisionNote}”</p>
      ) : (
        a && <p className="mt-1.5 text-[14px] text-muted">No note was added.</p>
      )}
    </div>
  );
}
