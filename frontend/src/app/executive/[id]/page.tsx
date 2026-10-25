"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { api, type ApiError, type FinancialPreview, type Proposal } from "@/lib/api";
import { approvalGate, personLabel, type PreviewState } from "@/lib/api/mappers";
import { Avatar } from "@/components/avatars";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { ApprovalSummary, DecisionRecord } from "@/components/review";
import { newIdempotencyKey } from "@/lib/format";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import {
  Button,
  ErrorNote,
  FindingMark,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  Section,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
  usePolling,
} from "@/components/ui";

type Decision = "approve" | "request_changes" | "reject";

const CHOICES: { value: Decision; label: string }[] = [
  { value: "approve", label: "Approve" },
  { value: "request_changes", label: "Request changes" },
  { value: "reject", label: "Reject" },
];

const TOTAL_STATUS: Record<string, string> = {
  price_unknown: "Price unknown",
  listed_subtotal_only: "Listed subtotal only. Shipping and tax are unknown.",
  subtotal_plus_shipping_tax_unknown: "Subtotal plus shipping. Tax is unknown.",
};

export default function ExecutiveProposalPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <ExecutiveProposal />
    </Suspense>
  );
}

function ExecutiveProposal() {
  const { id } = useParams<{ id: string }>();
  const prop = useLoad(() => api.getProposal(id), [id]);
  // The server's preview: cached on open, refreshed against the bank when Approve is chosen.
  const live = useLoad(() => api.getFinancialPreview(id), [id]);
  const [notice, setNotice] = useState<string | null>(null);
  const p = prop.data;

  const f: FinancialPreview | null = live.data ?? p?.financialAssessment ?? null;
  const preview: PreviewState = f ? { kind: "ready", preview: f } : live.error ? { kind: "error", message: live.error.message } : { kind: "loading" };

  async function refreshPreview(fresh: boolean) {
    try {
      // refresh=true re-reads the Nessie sandbox account (a free read; no research, no purchase).
      live.setData(await api.getFinancialPreview(id, { refresh: fresh }));
    } catch {
      await live.refresh();
    }
  }

  // Notice a new revision, a decision by someone else or an execution update. Read-only.
  const watching = !!p && (p.decision === "awaiting_review" || p.execution === "queued" || p.execution === "submitting");
  usePolling(
    async () => {
      await Promise.all([prop.refresh(), live.refresh()]);
    },
    5000,
    watching,
  );

  const awaiting = p?.decision === "awaiting_review";

  return (
    <Page>
      <PageHeader
        title={p?.requestTitle ?? "Proposal"}
        back={{ href: "/executive", label: "Approvals" }}
        amount={p ? p.expenseCents : undefined}
        amountLabel={p ? `Proposed expense · revision ${p.revision}` : undefined}
      />
      {prop.loading && <Loading />}
      <ErrorNote error={prop.error} onRetry={prop.reload} />

      {p && (
        <>
          {awaiting && <ApprovalSummary p={p} f={f} status={preview.kind} onRefresh={() => void refreshPreview(true)} />}
          {awaiting && <Warnings p={p} f={f} />}
          <ProductCard p={p} />
          {awaiting && notice && (
            <p role="alert" className="mb-4 rounded-xl bg-orange-soft p-3 text-[14px] font-medium text-warn">{notice}</p>
          )}
          {awaiting && (
            <DecisionPanel
              key={`${p.id}|${p.revision}|${p.expenseCents}`}
              p={p}
              preview={preview}
              refreshPreview={refreshPreview}
              onDecided={(next) => {
                setNotice(null);
                prop.setData(next);
              }}
              onConflict={() => {
                setNotice("This proposal changed while you were reviewing it. Review the latest version before deciding.");
                void prop.refresh();
                void live.refresh();
              }}
            />
          )}
          {!awaiting && <Outcome p={p} reload={prop.refresh} />}
          <ReviewSections p={p} />
        </>
      )}
    </Page>
  );
}

/** Server blockers first (red), then what the approver should weigh (orange). */
function Warnings({ p, f }: { p: Proposal; f: FinancialPreview | null }) {
  const r = p.review;
  const blockers = (f?.blockingReasons ?? []).filter((b) => b.code !== "not_awaiting_review");
  const unknownMandatory = r ? r.findings.filter((x) => x.status !== "supported" && r.requirements.some((q) => q.mandatory && q.label === x.requirement)) : [];
  const staleShown = blockers.some((b) => b.code === "offer_stale");
  const weigh = unknownMandatory.length > 0 || p.unresolved.length > 0 || (!!r?.stale && !staleShown);
  if (!blockers.length && !weigh) return null;
  return (
    <section aria-label="Before you decide" className="mb-4 space-y-2">
      {blockers.length > 0 && (
        <div role="alert" className="rounded-2xl bg-bad-soft p-4">
          <h2 className="text-[15px] font-semibold text-bad">Approval is blocked</h2>
          <ul className="mt-1 list-disc pl-5 text-[14px] text-ink">{blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
          <p className="mt-1.5 text-[13px] text-muted">You can still request changes or reject.</p>
        </div>
      )}
      {weigh && (
        <div role="note" className="rounded-2xl bg-orange-soft p-4">
          <h2 className="text-[15px] font-semibold text-orange-ink">Check before deciding</h2>
          <ul className="mt-1 list-disc pl-5 text-[14px] text-ink">
            {r?.stale && !staleShown && <li>The offer evidence has expired. Approval is refused until research is rerun.</li>}
            {unknownMandatory.map((x) => {
              const res = p.requirementResolutions.find((y) => y.requirement === x.requirement);
              return (
                <li key={`m-${x.requirement}`}>
                  Required: {x.requirement} — {x.status === "contradicted" ? "the listing contradicts it" : "not confirmed by the evidence"}
                  {res && (
                    <span className="block text-[13px]">
                      {res.kind === "verified" ? "Requester says they verified it: " : "Requester recorded an exception: "}“{res.note}”
                    </span>
                  )}
                </li>
              );
            })}
            {p.unresolved.map((u) => <li key={`u-${u}`}>{u}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function ProductCard({ p }: { p: Proposal }) {
  const r = p.review;
  return (
    <Section>
      <ul>
        {p.lines.map((l) => (
          <li key={l.itemId} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
            <p className="text-[13px] text-muted">Product · {l.quantityText}</p>
            <div className="mt-0.5 flex gap-3">
              {l.imageUrl && isSafeHttpUrl(l.imageUrl) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-lg bg-raised object-contain" />
              )}
              <p className="text-[17px] font-semibold leading-snug">{l.title}</p>
            </div>
            <p className="text-[14px] text-muted">
              {l.seller ?? "Unknown seller"}
              {l.listedSubtotalCents !== null && ` · ${formatCents(l.listedSubtotalCents)} listed`}
            </p>
            {l.sourceUrl && isSafeHttpUrl(l.sourceUrl) && (
              <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="touch text-[14px] font-medium text-accent">
                Source listing
              </a>
            )}
          </li>
        ))}
      </ul>
      {r?.observedAt && (
        <p className="mt-1 text-[13px] text-muted">
          Observed {formatWhen(r.observedAt)}
          {r.expiresAt && `, fresh until ${formatWhen(r.expiresAt)}`}
          {r.fromCache && ". Reused from an earlier search"}.
        </p>
      )}
      <p className="mt-2 flex items-center gap-2 text-[14px]">
        <Avatar role="employee" size={22} />
        <span>
          Requested by <span className="font-medium">{personLabel(p.requester, "Unknown requester")}</span>
          {p.submittedAt && <span className="text-muted"> · submitted {formatWhen(p.submittedAt)}</span>}
        </span>
      </p>
    </Section>
  );
}

// ---------- the proposal as submitted ----------

function ReviewSections({ p }: { p: Proposal }) {
  const r = p.review;
  return (
    <>
      <Section title="Request">
        <dl>
          <KeyValue label="Revision" value={p.revision} />
        </dl>
        {r?.purpose && (
          <>
            <h3 className="mb-1 mt-3 text-[15px] font-semibold">Business purpose</h3>
            <p className="text-[16px]">{r.purpose}</p>
          </>
        )}
        {r && r.requirements.length > 0 && (
          <>
            <h3 className="mb-1 mt-3 text-[15px] font-semibold">Requirements</h3>
            <ul className="list-disc pl-5 text-[16px]">
              {r.requirements.map((x) => (
                <li key={x.label}>
                  {x.label}
                  {!x.mandatory && <span className="text-muted"> (nice to have)</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {r && r.findings.length > 0 && (
        <Section title="Requirements and evidence">
          <ul className="divide-y divide-rule">
            {r.findings.map((f) => (
              <li key={f.requirement} className="py-2.5 first:pt-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[16px]">{f.requirement}</span>
                  <FindingMark status={f.status} />
                </div>
                <p className="mt-0.5 text-[13px] text-muted">{f.evidence}</p>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-muted">Evidence comes from the listing, not from the manufacturer.</p>
        </Section>
      )}

      <Section title="Cost">
        <dl>
          {r && <KeyValue label="Unit price" value={r.cost.unitPriceCents === null ? "Unknown" : formatCents(r.cost.unitPriceCents)} />}
          {r && r.cost.packagesRequired !== null && <KeyValue label="Quantity" value={r.cost.packagesRequired} />}
          <KeyValue label="Listed subtotal" value={formatCents(p.researchSubtotalCents)} />
          {r && <KeyValue label="Shipping" value={r.cost.shippingCents === null ? "Unknown" : formatCents(r.cost.shippingCents)} />}
          <KeyValue label="Tax" value="Unknown" />
          <KeyValue label="Request budget ceiling" value={formatCents(p.budgetCeilingCents)} note="The most the requester asked to spend. Not an approved amount." />
          <KeyValue
            label="Proposed expense"
            value={formatCents(p.expenseCents)}
            note="Entered and confirmed by the requester (may include their shipping/tax estimate). Not verified at a merchant checkout."
          />
        </dl>
        {r && <p className="mt-1 text-[13px] text-muted">{TOTAL_STATUS[r.cost.totalStatus] ?? ""}</p>}
      </Section>

      {r && r.alternatives.length > 0 && (
        <Section title="Alternatives considered">
          <ul>
            {r.alternatives.map((a) => (
              <li key={a.title} className="border-t border-rule py-2.5 first:border-t-0 first:pt-0">
                <p className="text-[16px]">{a.title}</p>
                <p className="text-[13px] text-muted">
                  {a.seller ?? "Unknown seller"} · {a.eligibility.replace("_", " ")}
                  {a.costCents !== null && ` · ${formatCents(a.costCents)}`}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Requester’s case">
        <p className="text-[16px]">{p.justification || "No justification given."}</p>
        <p className="mt-2 text-[14px]">
          {p.suitabilityConfirmed
            ? "The requester confirmed they reviewed technical suitability. That is their review, not a certification."
            : "Technical suitability was not confirmed."}
        </p>
      </Section>

      {r && (r.revisions.length > 1 || r.history.length > 0) && (
        <Section title="History">
          <ul>
            {r.revisions.map((v) => (
              <li key={`rev-${v.version}`} className="py-1 text-[14px]">
                Revision {v.version} submitted{v.submittedAt ? ` ${formatWhen(v.submittedAt)}` : ""}
                {v.exactAmountCents !== null && ` for ${formatCents(v.exactAmountCents)}`}
              </li>
            ))}
            {r.history.map((h) => (
              <li key={`dec-${h.at}`} className="py-1 text-[14px]">
                {h.decision.replace("_", " ")} on revision {h.version} by {personLabel(h.actor)}, {formatWhen(h.at)}
                {h.note && <span className="text-muted"> — “{h.note}”</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

// ---------- decision ----------

function DecisionPanel({
  p,
  preview,
  refreshPreview,
  onDecided,
  onConflict,
}: {
  p: Proposal;
  preview: PreviewState;
  refreshPreview: (fresh: boolean) => Promise<void>;
  onDecided: (p: Proposal) => void;
  onConflict: () => void;
}) {
  // Everything here resets when the revision or amount changes, because the parent re-keys this panel.
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false); // never checked by default
  const [tried, setTried] = useState(false);
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  // One key per logical decision; a retry with the same decision, note and amount reuses it.
  const keyRef = useRef<{ sig: string; key: string } | null>(null);

  const amount = formatCents(p.expenseCents);
  const seller = p.lines[0]?.seller ?? null;
  const gate = approvalGate(checking ? { kind: "loading" } : preview, p.revision, ack);
  const fp = preview.kind === "ready" ? preview.preview : null;
  const needsMapping = !!fp?.blockingReasons.some((r) => r.code === "merchant_mapping_required");
  const noteMissing = choice === "request_changes" && !note.trim();

  async function choose(d: Decision) {
    setChoice(d);
    setError(null);
    setTried(false);
    setLinked(null);
    if (d === "approve") {
      setChecking(true);
      await refreshPreview(true); // a bank read so the figures above are current; never a purchase
      setChecking(false);
    }
  }

  async function submit() {
    if (!choice || pending) return;
    setTried(true);
    if (noteMissing) {
      document.getElementById("decision-note")?.focus();
      return;
    }
    if (choice === "approve" && !gate.enabled) {
      if (!ack) document.getElementById("approve-ack")?.focus();
      return;
    }
    const sig = `${p.id}|${p.revision}|${p.expenseCents}|${choice}|${note}`;
    if (keyRef.current?.sig !== sig) keyRef.current = { sig, key: newIdempotencyKey() };
    setPending(true);
    setError(null);
    try {
      const next = await api.decide({
        proposalId: p.id,
        version: p.revision,
        decision: choice,
        note: note.trim(),
        exactAmountCents: p.expenseCents,
        idempotencyKey: keyRef.current.key,
      });
      onDecided(next);
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === "VERSION_CONFLICT" || err.code === "TERMS_CHANGED") onConflict();
      else {
        setError(err);
        // The server refused (budget, offer freshness, mapping…): show its current view of the blockers.
        void refreshPreview(false);
      }
    } finally {
      setPending(false);
    }
  }

  async function link() {
    if (!seller || linking) return;
    setLinking(true);
    setError(null);
    try {
      const m = await api.createMerchantMapping(seller);
      setLinked(`${m.merchantName ?? "Sandbox merchant"} (${m.nessieMerchantId})`);
      await refreshPreview(true);
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setLinking(false);
    }
  }

  const confirmLabel = pending
    ? "Saving…"
    : choice === "approve"
      ? `Approve ${amount}`
      : choice === "reject"
        ? "Reject proposal"
        : "Send back for changes";
  // The ticked-box reminder only shows after a try; real blockers show straight away.
  const showGate = choice === "approve" && !!gate.reason && (tried || gate.reason !== "Tick the confirmation to approve.");

  return (
    <section aria-labelledby="decision-title" className="mb-4 rounded-2xl bg-paper p-4 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_2px_8px_rgba(16,24,40,0.04)]">
      <h2 id="decision-title" className="mb-3 text-[17px] font-semibold">Your decision</h2>
      <div role="radiogroup" aria-label="Decision" className="grid grid-cols-3 gap-2">
        {CHOICES.map((c) => {
          const on = choice === c.value;
          return (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => void choose(c.value)}
              className={`min-h-12 rounded-xl px-2 text-[14px] font-semibold leading-tight ${
                on ? (c.value === "reject" ? "bg-bad text-white" : "bg-accent text-white") : "bg-accent-soft text-accent active:bg-accent-soft-press"
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-[13px] text-muted">
        {choice === null
          ? "Nothing is saved until you confirm below."
          : choice === "approve"
            ? "Approving records a simulated purchase in the Nessie sandbox. Nothing is ordered and no real money moves."
            : choice === "request_changes"
              ? "The employee sees your note, can revise the proposal and resubmit it as a new revision."
              : "Rejecting closes this proposal. No purchase is recorded."}
      </p>

      {choice === "approve" && checking && <p className="mt-2 text-[13px] text-muted">Checking the latest bank figures…</p>}
      {/* Seller setup is offered up front: it is a one-time sandbox step, not an approval. */}
      {needsMapping && seller && (
        <div className="mt-3 rounded-xl bg-orange-soft p-3 text-[14px]">
          <p className="font-medium text-warn">No Nessie sandbox merchant is linked to {seller}.</p>
          <p className="mt-1 text-ink">Approval needs one so the simulated purchase is booked against the right record. Nothing has been reserved.</p>
          <div className="mt-3">
            <Button variant="quiet" disabled={linking} onClick={link}>
              {linking ? "Linking…" : `Create a sandbox merchant for ${seller}`}
            </Button>
          </div>
        </div>
      )}
      {linked && <p className="mt-3 text-[14px] text-ok">Linked to {linked}.</p>}

      {choice && (
        <div className="mt-4">
          <label htmlFor="decision-note" className="mb-1.5 block text-[15px] font-medium">
            {choice === "request_changes" ? "What needs to change? (required)" : "Note (optional)"}
          </label>
          <textarea
            id="decision-note"
            rows={choice === "request_changes" ? 5 : 3}
            className={inputClass}
            value={note}
            placeholder={choice === "request_changes" ? "For example: choose a cheaper option, lower the quantity to 2, or add a warranty." : undefined}
            aria-invalid={tried && noteMissing}
            aria-describedby={tried && noteMissing ? "decision-note-error" : undefined}
            onChange={(e) => setNote(e.target.value)}
          />
          {tried && noteMissing && (
            <p id="decision-note-error" role="alert" className="mt-1 text-[13px] text-bad">Say what the employee should change.</p>
          )}
          <p className="mt-1 text-[13px] text-muted">The requester sees this note with your decision.</p>
        </div>
      )}

      {choice === "approve" && (
        <>
          <label className="mt-4 flex items-start gap-3 text-[16px]">
            <input
              id="approve-ack"
              type="checkbox"
              className="mt-1 h-5 w-5 shrink-0 accent-[var(--accent)]"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              aria-describedby={showGate ? "approve-gate" : undefined}
            />
            <span>
              I approve this simulated purchase for {amount} (revision {p.revision}) and understand that it commits this amount from the available company budget.
            </span>
          </label>
          {showGate && (
            <p id="approve-gate" role={tried ? "alert" : undefined} className="mt-2 text-[13px] font-medium text-bad">{gate.reason}</p>
          )}
        </>
      )}

      <ErrorNote error={error} />
      {choice && (
        <div className="mt-4">
          <Button disabled={pending || (choice === "approve" && (checking || (!gate.enabled && ack)))} onClick={submit}>
            {confirmLabel}
          </Button>
        </div>
      )}
    </section>
  );
}

// ---------- after a decision ----------

function Outcome({ p, reload }: { p: Proposal; reload: () => Promise<void> }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const ex = p.executionDetail;

  async function check() {
    if (!ex || checking) return;
    setChecking(true);
    setError(null);
    try {
      await api.reconcile(ex.id, "check");
      await reload();
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Section title="Decision saved">
      <DecisionRecord p={p} />
      {p.decision === "changes_requested" && (
        <p className="mt-2 text-[13px] text-muted">The employee can revise and resubmit. A new revision appears in Approvals.</p>
      )}
      {p.decision === "approved" && (
        <div className="mt-3">
          <dl>
            <KeyValue label="Purchase record" value={ex ? <ExecutionStatusText status={ex.status} /> : "Not started"} />
          </dl>
          {ex && (
            <>
              <ExecutionAmounts d={ex} />
              <ExecutionWarnings d={ex} />
              {(ex.status === "uncertain" || ex.status === "queued" || ex.status === "submitting") && (
                <div className="mt-3">
                  <ErrorNote error={error} />
                  <Button variant="quiet" disabled={checking} onClick={check}>{checking ? "Checking…" : "Check status"}</Button>
                  <p className="mt-1.5 text-[13px] text-muted">This only looks up the result. It never sends the purchase again.</p>
                </div>
              )}
              <Link href={`/purchases/${ex.id}`} className="touch mt-2 text-[15px] font-medium text-accent">View purchase record</Link>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
