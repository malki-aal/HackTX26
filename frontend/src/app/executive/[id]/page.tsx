"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { api, type ApiError, type Budget, type FinancialPreview, type Proposal } from "@/lib/api";
import { approvalGate, personLabel, type PreviewState } from "@/lib/api/mappers";
import { Avatar } from "@/components/avatars";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { newIdempotencyKey } from "@/lib/format";
import { DECISION_LABEL } from "@/lib/labels";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import {
  Button,
  ErrorNote,
  FindingMark,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  ProgressBar,
  SandboxNote,
  Section,
  formatWhen,
  inputClass,
  normalizeError,
  useLoad,
  usePolling,
} from "@/components/ui";

type Decision = "approve" | "request_changes" | "reject";

const DECISION_BUTTON: Record<Decision, string> = {
  approve: "Accept",
  request_changes: "Change",
  reject: "Deny",
};

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
  // Cached read (no bank call) for Nessie's reported balance, shown separately from Runway's available budget.
  const budget = useLoad(() => api.getBudget({ fresh: false }), []);
  const [notice, setNotice] = useState<string | null>(null);
  const p = prop.data;

  // Notice a new revision, a decision by someone else or an execution update. Read-only.
  const watching = !!p && (p.decision === "awaiting_review" || p.execution === "queued" || p.execution === "submitting");
  usePolling(prop.refresh, 5000, watching);

  const awaiting = p?.decision === "awaiting_review";

  return (
    <Page>
      <PageHeader
        title={p?.requestTitle ?? "Proposal"}
        back={{ href: "/executive", label: "Approvals" }}
        amount={p ? p.expenseCents : undefined}
        amountLabel={p ? `Requested expense · revision ${p.revision}` : undefined}
      >
        {p && (
          <div className="mt-4">
            <ProgressBar value={p.expenseCents} max={p.budgetCeilingCents} over={p.expenseCents > p.budgetCeilingCents} />
            <p className="mt-1.5 text-[13px] text-white/85">of {formatCents(p.budgetCeilingCents)} budget ceiling</p>
          </div>
        )}
      </PageHeader>
      {prop.loading && <Loading />}
      <ErrorNote error={prop.error} onRetry={prop.reload} />

      {p && <ReviewSections p={p} />}

      {p && awaiting && (
        <>
          {notice && (
            <p role="alert" className="mb-4 rounded-xl bg-orange-soft p-3 text-[14px] font-medium text-warn">{notice}</p>
          )}
          <DecisionStep
            key={`${p.id}|${p.revision}|${p.expenseCents}`}
            p={p}
            budget={budget.data}
            refreshBudget={budget.refresh}
            onDecided={(next) => {
              setNotice(null);
              prop.setData(next);
              void budget.refresh();
            }}
            onConflict={() => {
              setNotice("This proposal changed while you were reviewing it. Review the latest version before deciding.");
              void prop.refresh();
            }}
          />
        </>
      )}

      {p && !awaiting && <Outcome p={p} reload={prop.refresh} />}
    </Page>
  );
}

// ---------- the proposal as submitted ----------

function ReviewSections({ p }: { p: Proposal }) {
  const r = p.review;
  const unknownMandatory = r ? r.findings.filter((f) => f.status !== "supported" && r.requirements.some((q) => q.mandatory && q.label === f.requirement)) : [];
  return (
    <>
      {(p.unresolved.length > 0 || unknownMandatory.length > 0 || r?.stale || p.requirementResolutions.length > 0) && (
        <div role="note" className="mb-4 rounded-2xl bg-orange-soft p-4">
          <p className="text-[15px] font-semibold text-orange-ink">Check before deciding</p>
          <ul className="mt-1 list-disc pl-5 text-[15px] text-ink">
            {r?.stale && <li>The offer evidence has expired. Approval is refused until research is rerun.</li>}
            {unknownMandatory.map((f) => {
              const res = p.requirementResolutions.find((x) => x.requirement === f.requirement);
              return (
                <li key={`m-${f.requirement}`}>
                  Required: {f.requirement} — {f.status === "contradicted" ? "the listing contradicts it" : "not confirmed by the evidence"}
                  {res && (
                    <span className="block text-[14px]">
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
      <Section title="Request">
        <dl>
          <KeyValue
            label="Requested by"
            value={<span className="inline-flex items-center gap-2"><Avatar role="employee" size={24} />{personLabel(p.requester, "Unknown requester")}</span>}
            note={p.requester?.demo ? "A demo identity, not an account." : undefined}
          />
          {p.submittedAt && <KeyValue label="Submitted" value={formatWhen(p.submittedAt)} />}
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

      <Section title="Selected offer">
        <ul>
          {p.lines.map((l) => (
            <li key={l.itemId} className="border-t border-rule py-3 first:border-t-0 first:pt-0">
              <p className="text-[13px] text-muted">{l.itemName} · {l.quantityText}</p>
              <div className="flex gap-3">
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
          <p className="mt-2 text-[13px] text-muted">
            Observed {formatWhen(r.observedAt)}
            {r.expiresAt && `, fresh until ${formatWhen(r.expiresAt)}`}
            {r.fromCache && ". Reused from an earlier search"}.
          </p>
        )}
        {r?.stale && (
          <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
            This offer is out of date. Approval will be refused until research is run again.
          </p>
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

function DecisionStep({
  p,
  budget,
  refreshBudget,
  onDecided,
  onConflict,
}: {
  p: Proposal;
  budget: Budget | null;
  refreshBudget: () => Promise<void>;
  onDecided: (p: Proposal) => void;
  onConflict: () => void;
}) {
  // Everything here resets when the revision or amount changes, because the parent re-keys this step.
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState("");
  const [ack, setAck] = useState(false); // never checked by default
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [linking, setLinking] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  // The server's preview. Starts from the cached assessment in the proposal detail; refreshed before approval.
  const [preview, setPreview] = useState<PreviewState>(
    p.financialAssessment ? { kind: "ready", preview: p.financialAssessment } : { kind: "loading" },
  );
  // One key per logical decision; a retry with the same decision, note and amount reuses it.
  const keyRef = useRef<{ sig: string; key: string } | null>(null);

  const amount = formatCents(p.expenseCents);
  const gate = approvalGate(preview, p.revision, ack);
  const fp: FinancialPreview | null = preview.kind === "ready" ? preview.preview : null;
  const needsMapping = !!fp?.blockingReasons.some((r) => r.code === "merchant_mapping_required");

  async function refreshPreview() {
    setPreview({ kind: "loading" });
    try {
      // refresh=true re-reads the Nessie sandbox account (a free read; no research, no purchase).
      const next = await api.getFinancialPreview(p.id, { refresh: true });
      setPreview({ kind: "ready", preview: next });
      void refreshBudget();
    } catch (e) {
      setPreview({ kind: "error", message: normalizeError(e).message });
    }
  }

  function choose(d: Decision) {
    setChoice(d);
    setError(null);
    setLinked(null);
    if (d === "approve") void refreshPreview();
  }

  async function submit() {
    if (!choice || pending) return;
    if (choice === "approve" && !gate.enabled) return;
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
        if (choice === "approve") void refreshPreview();
      }
    } finally {
      setPending(false);
    }
  }

  async function link() {
    const seller = p.lines[0]?.seller;
    if (!seller || linking) return;
    setLinking(true);
    setError(null);
    try {
      const m = await api.createMerchantMapping(seller);
      setLinked(`${m.merchantName ?? "Sandbox merchant"} (${m.nessieMerchantId})`);
      await refreshPreview();
    } catch (e) {
      setError(normalizeError(e));
    } finally {
      setLinking(false);
    }
  }

  if (!choice) {
    return (
      <Section title="Review">
        <BudgetImpact preview={preview} budget={budget} onRefresh={refreshPreview} />
        <p className="mb-4 mt-4 text-[14px] text-muted">
          Check the proposal above, then choose. Nothing happens until you confirm on the next step.
        </p>
        <div className="space-y-3">
          <Button onClick={() => choose("approve")}>Accept</Button>
          <Button variant="quiet" onClick={() => choose("request_changes")}>Change</Button>
          <Button variant="quiet" onClick={() => choose("reject")}>Deny</Button>
        </div>
        <p className="mt-3 text-[13px] text-muted">
          Change sends your notes back to the employee so they can edit the request and resubmit.
        </p>
      </Section>
    );
  }

  const label = DECISION_BUTTON[choice];
  return (
    <Section title={`Confirm: ${label.toLowerCase()}`}>
      <dl>
        <KeyValue label="Proposal" value={p.requestTitle} />
        <KeyValue label="Revision" value={p.revision} />
        <KeyValue label="Proposed expense" value={amount} />
      </dl>
      {choice === "approve" && <div className="mt-3"><BudgetImpact preview={preview} budget={budget} onRefresh={refreshPreview} /></div>}

      <div className="mt-4">
        <label htmlFor="decision-note" className="mb-1.5 block text-[15px] font-medium">
          {choice === "request_changes" ? "What needs to change?" : "Note (optional)"}
        </label>
        <textarea
          id="decision-note"
          rows={choice === "request_changes" ? 6 : 3}
          className={inputClass}
          value={note}
          placeholder={choice === "request_changes" ? "Be specific: for example, choose a cheaper monitor, lower the quantity to 2, or add a warranty." : undefined}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="mt-1 text-[13px] text-muted">
          {choice === "request_changes" ? "The employee sees this and can edit the request and resubmit." : "The requester will see this note."}
        </p>
      </div>

      {choice === "approve" && (
        <label className="mt-4 flex items-start gap-3 text-[16px]">
          <input
            id="approve-ack"
            type="checkbox"
            className="mt-1 h-5 w-5 accent-[var(--accent)]"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <span>
            I approve this simulated purchase for {amount} (revision {p.revision}) and understand that it commits this amount from the available company budget.
          </span>
        </label>
      )}

      {choice === "approve" && needsMapping && (
        <div role="alert" className="mt-4 rounded-xl bg-orange-soft p-3 text-[14px]">
          <p className="font-medium text-warn">No Nessie sandbox merchant is linked to {p.lines[0]?.seller ?? "this seller"}.</p>
          <p className="mt-1 text-ink">
            Approval needs one so the simulated purchase is booked against the right sandbox record. Nothing has been reserved.
          </p>
          <div className="mt-3">
            <Button variant="quiet" disabled={linking} onClick={link}>
              {linking ? "Linking…" : `Create a sandbox merchant for ${p.lines[0]?.seller ?? "this seller"}`}
            </Button>
          </div>
        </div>
      )}
      {linked && <p className="mt-4 text-[14px] text-ok">Linked to {linked}.</p>}
      <ErrorNote error={error} />

      {choice === "approve" && gate.reason && (
        <p id="approve-gate" className="mt-3 text-[14px] text-muted">{gate.reason}</p>
      )}
      <div className="mt-4 space-y-3">
        <Button
          disabled={pending || (choice === "approve" && !gate.enabled) || (choice === "request_changes" && !note.trim())}
          onClick={submit}
        >
          {pending ? "Working…" : choice === "approve" ? `Accept ${amount}` : choice === "reject" ? "Deny proposal" : "Send back to employee"}
        </Button>
        <Button variant="quiet" disabled={pending} onClick={() => setChoice(null)}>Back</Button>
      </div>
    </Section>
  );
}

/** Server-calculated effect of approval. Runway's available budget is kept apart from Nessie's reported balance. */
function BudgetImpact({ preview, budget, onRefresh }: { preview: PreviewState; budget: Budget | null; onRefresh: () => void }) {
  if (preview.kind === "loading") return <Loading label="Checking the budget" />;
  if (preview.kind === "error") {
    return (
      <div role="alert" className="rounded-xl bg-bad-soft p-3 text-[14px]">
        <p className="font-medium text-bad">Budget check unavailable</p>
        <p className="mt-1 text-ink">{preview.message}</p>
        <button type="button" className="touch mt-1 text-[14px] font-medium text-accent" onClick={onRefresh}>Try again</button>
      </div>
    );
  }
  const f = preview.preview;
  const fetched = f.freshness.fetchedAt ? formatWhen(f.freshness.fetchedAt) : null;
  return (
    <div>
      <h3 className="mb-1 text-[15px] font-semibold">Budget impact</h3>
      <dl>
        <KeyValue label="Available budget now" value={f.currentAvailableCents === null ? "Unknown" : formatCents(f.currentAvailableCents)} />
        <KeyValue label="This expense" value={formatCents(f.exactExpenseCents)} />
        <KeyValue
          label="Available after approval"
          value={f.projectedAvailableCents === null ? "Unknown" : formatCents(f.projectedAvailableCents)}
          note={f.reservationIncluded ? "This proposal’s reservation is already counted, so it isn’t subtracted again." : undefined}
        />
        {budget && budget.reportedBalanceCents !== null && (
          <KeyValue label="Nessie reported balance" value={formatCents(budget.reportedBalanceCents)} note="The sandbox account’s balance. Not the same as available budget." />
        )}
      </dl>
      <p className="mt-1 text-[13px] text-muted">
        {f.label} {fetched ? `Bank data ${f.freshness.refreshedNow ? "refreshed" : "cached"} ${fetched}.` : "No bank data yet."}{" "}
        <button type="button" className="font-medium text-accent" onClick={onRefresh}>Refresh</button>
      </p>
      {f.unknowns.length > 0 && <p className="mt-1 text-[13px] text-muted">Not included: {f.unknowns.join(", ")}.</p>}
      {f.blockingReasons.length > 0 && (
        <div role="alert" className="mt-2 rounded-xl bg-bad-soft p-3">
          <p className="text-[14px] font-medium text-bad">Approval blocked</p>
          <ul className="mt-1 list-disc pl-5 text-[14px] text-ink">
            {f.blockingReasons.map((r) => <li key={r.code}>{r.message}</li>)}
          </ul>
        </div>
      )}
    </div>
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
    <Section title="Outcome">
      <dl>
        <KeyValue label="Decision" value={DECISION_LABEL[p.decision]} />
        <KeyValue label="Purchase record" value={ex ? <ExecutionStatusText status={ex.status} /> : "Not started"} />
      </dl>
      {p.decisionNote && <p className="mt-2 text-[16px]"><span className="text-muted">Note: </span>{p.decisionNote}</p>}
      {ex && (
        <div className="mt-3">
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
        </div>
      )}
      <SandboxNote />
    </Section>
  );
}
