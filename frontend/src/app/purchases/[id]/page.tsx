"use client";

import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type ApiError, type ExecutionDetail } from "@/lib/api";
import { ExecutionAmounts, ExecutionStatusText, ExecutionWarnings } from "@/components/execution";
import { formatDate } from "@/lib/format";
import { EXECUTION_LABEL } from "@/lib/labels";
import { isSafeHttpUrl } from "@/lib/money";
import {
  Button,
  ErrorNote,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  SandboxNote,
  Section,
  normalizeError,
  useLoad,
} from "@/components/ui";

export default function PurchaseRecordPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <PurchaseRecord />
    </Suspense>
  );
}

function PurchaseRecord() {
  const { id } = useParams<{ id: string }>();
  const exec = useLoad(() => api.getExecution(id), [id]);
  const proposal = useLoad(async () => (exec.data ? api.getProposal(exec.data.proposalId) : null), [exec.data?.proposalId]);
  const [checked, setChecked] = useState<ExecutionDetail | null>(null);
  const [checkError, setCheckError] = useState<ApiError | null>(null);
  const [checking, setChecking] = useState(false);
  const d = checked ?? exec.data;
  const p = proposal.data;

  async function check() {
    if (checking) return;
    setChecking(true);
    setCheckError(null);
    try {
      setChecked(await api.reconcile(id, "check"));
    } catch (e) {
      setCheckError(normalizeError(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Page>
      <PageHeader
        title="Purchase record"
        back={{ href: "/", label: "Requests" }}
        amount={d ? d.amountCents : undefined}
        amountLabel="Approved amount"
        stats={d ? [{ label: "Status", value: EXECUTION_LABEL[d.status] }] : undefined}
      />
      {(exec.loading || proposal.loading) && <Loading />}
      <ErrorNote error={exec.error ?? proposal.error} onRetry={exec.reload} />

      {d && (
        <>
          <p className="mb-4 rounded-xl bg-accent-soft p-3 text-[14px]">
            A simulated banking record in the Nessie sandbox. It is not a merchant receipt or proof of shipment, and no
            order was placed.
          </p>

          <Section title="Status">
            <p className="text-[17px]"><ExecutionStatusText status={d.status} /></p>
            <ExecutionWarnings d={d} />
            {(d.status === "uncertain" || d.status === "queued" || d.status === "submitting") && (
              <div className="no-print mt-3">
                <ErrorNote error={checkError} />
                <Button variant="quiet" onClick={check} disabled={checking}>
                  {checking ? "Checking…" : "Check status"}
                </Button>
                <p className="mt-1.5 text-[13px] text-muted">This only looks up the result. It never sends the purchase again.</p>
              </div>
            )}
          </Section>

          {p && (
            <Section title="Request">
              <p className="text-[17px] font-semibold">{p.requestTitle}</p>
              <ul className="mt-2">
                {p.lines.map((l) => (
                  <li key={l.itemId} className="border-t border-rule py-2.5 first:border-t-0">
                    <p className="text-[13px] text-muted">{l.itemName} · {l.quantityText}</p>
                    <p className="text-[16px]">{l.title}</p>
                    <p className="text-[14px] text-muted">{l.seller ?? "Unknown seller"}</p>
                    {l.sourceUrl && isSafeHttpUrl(l.sourceUrl) && (
                      <a href={l.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-[14px] font-medium text-accent">
                        Source listing<span className="hidden print:inline"> ({l.sourceUrl})</span>
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="People">
            <dl>
              <KeyValue label="Requested by" value={p ? `${p.requester} (demo role)` : "Not available"} />
              <KeyValue
                label="Approved by"
                value={p?.approval ? `${p.approval.actor} (demo role)` : "Not available"}
                note={p?.approval ? formatDate(p.approval.at) : undefined}
              />
            </dl>
            {p?.decisionNote && <p className="mt-1 text-[16px]"><span className="text-muted">Note: </span>{p.decisionNote}</p>}
            <p className="mt-1 text-[13px] text-muted">Demo roles are labels, not accounts. There is no sign-in yet.</p>
          </Section>

          <Section title="Merchant">
            <dl>
              <KeyValue label="Seller found in research" value={d.merchant.researchedSeller ?? "Unknown"} />
              <KeyValue
                label="Nessie sandbox merchant"
                value={d.merchant.nessieMerchantId ? (d.merchant.nessieMerchantName ?? "Name not provided") : "Merchant mapping required"}
                note={d.merchant.nessieMerchantId ? `Merchant ID ${d.merchant.nessieMerchantId}` : "No sandbox merchant is linked to this seller."}
              />
            </dl>
            <p className="mt-1 text-[13px] text-muted">These are separate records. The sandbox merchant is not the real seller.</p>
          </Section>

          <Section title="Amounts">
            <ExecutionAmounts d={d} />
          </Section>

          <Section title="Purchase details">
            <dl>
              <KeyValue label="Purchase ID" value={d.purchaseId ?? "None yet"} />
              <KeyValue label="Nessie status" value={d.providerStatus ?? "Not reported"} />
              <KeyValue label="Record created" value={formatDate(d.createdAt)} />
              <KeyValue label="Last updated" value={formatDate(d.updatedAt)} />
            </dl>
            <SandboxNote />
          </Section>

          <div className="no-print border-t border-rule pt-5">
            <Button variant="quiet" onClick={() => window.print()}>Print summary</Button>
          </div>
        </>
      )}
    </Page>
  );
}
