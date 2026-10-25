"use client";

import { useParams, useRouter } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import { readSelection, selectionQuery, writeSelection } from "@/lib/selection";
import {
  Button,
  EligibilityMark,
  ErrorNote,
  FindingMark,
  KeyValue,
  Loading,
  Page,
  PageHeader,
  Section,
  formatWhen,
  useLoad,
} from "@/components/ui";

const AFFORDABILITY = {
  within_budget_provisional: "Within budget (provisional)",
  over_budget: "Over budget",
  unknown: "Unknown",
} as const;

export default function OfferDetailPage() {
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
      <OfferDetail />
    </Suspense>
  );
}

function OfferDetail() {
  const { id, offerId } = useParams<{ id: string; offerId: string }>();
  const { data, error, loading, reload } = useLoad(() => api.listCandidates(id), [id]);
  const request = useLoad(() => api.getRequest(id), [id]);
  const router = useRouter();
  const [imgFailed, setImgFailed] = useState(false);
  const offer = data?.find((o) => o.id === offerId);
  const lateHard = !!offer && offer.deadlineFit === "misses" && request.data?.deadlineKind === "hard";

  function choose() {
    if (!offer || !request.data) return;
    const next = { ...readSelection(id), [offer.itemId]: offer.id };
    writeSelection(id, next);
    // One item: go straight to the proposal. Several: return to pick the rest.
    router.push(request.data.items.length === 1 ? `/requests/${id}/proposal?sel=${encodeURIComponent(selectionQuery(next))}` : `/requests/${id}`);
  }

  return (
    <Page>
      <PageHeader
        title={offer?.title ?? "Offer"}
        back={{ href: `/requests/${id}`, label: "Offers" }}
        amount={offer ? offer.listedSubtotalCents : undefined}
        amountLabel="Listed subtotal"
        amountNote={offer ? `${offer.seller} · shipping and tax not included` : undefined}
      />
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && !offer && <p className="text-[14px] text-muted">This offer is no longer in the results.</p>}
      {offer && (
        <>
          <p className="mb-4 flex items-center gap-2 text-[14px] text-muted">
            {offer.seller} · <EligibilityMark value={offer.eligibility} />
          </p>

          {offer.imageUrl && isSafeHttpUrl(offer.imageUrl) && !imgFailed ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={offer.imageUrl} alt="" onError={() => setImgFailed(true)} className="mb-4 h-40 w-full object-contain" />
          ) : (
            <div className="mb-4 flex h-20 items-center justify-center border border-dashed border-rule text-[13px] text-muted">
              No image from the seller
            </div>
          )}

          <Section title="Price basis">
            <dl>
              <KeyValue label="Listed price" value={offer.unitPriceCents === null ? "Unknown" : `${formatCents(offer.unitPriceCents)} ${offer.packageQuantity > 1 ? `per ${offer.packageQuantity}-pack` : "each"}`} />
              <KeyValue label="Quantity needed" value={offer.packageQuantity > 1 ? `${offer.packagesRequired} ${offer.packagesRequired === 1 ? "pack" : "packs"} of ${offer.packageQuantity}` : `${offer.packagesRequired} (sold singly)`} />
              <KeyValue label="Listed subtotal" value={formatCents(offer.listedSubtotalCents)} />
              <KeyValue label="Shipping" value={offer.shippingCents === null ? "Unknown" : formatCents(offer.shippingCents)} />
              <KeyValue label="Tax" value={offer.taxCents === null ? "Unknown" : formatCents(offer.taxCents)} />
              <KeyValue label="Against your budget" value={AFFORDABILITY[offer.affordability]} />
              <KeyValue label="Delivery" value={offer.delivery.status === "stated" ? (offer.delivery.text ?? "Stated") : "Unknown"}
                note={offer.deliveryNote ?? (offer.deadlineFit === "meets" ? (offer.delivery.estimate ? "Estimated to arrive by your date" : "Arrives by your date") : offer.deadlineFit === "misses" ? "Arrives after your date" : offer.deadlineFit === "unknown" ? "Can't be checked against your date" : undefined)} />
            </dl>
            {offer.costNotes.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[13px] text-muted">
                {offer.costNotes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
            {offer.stale && (
              <p role="alert" className="mt-2 text-[14px] font-medium text-bad">
                This offer is out of date. Run research again before proposing it.
              </p>
            )}
            <p className="mt-2 text-[13px] text-muted">
              A complete total is shown only when shipping and tax are known. Observed {formatWhen(offer.observedAt)}; prices
              may have changed since.{offer.fromCache && " This result was reused from an earlier search."}
            </p>
          </Section>

          <Section title="Requirements">
            {/* Confirmed failures, then facts still unknown, then what the evidence supports. */}
            {([
              ["contradicted", "Doesn't meet"],
              ["unknown", "Not yet confirmed"],
              ["supported", "Confirmed"],
            ] as const).map(([status, heading]) => {
              const group = offer.findings.filter((f) => f.status === status);
              if (!group.length) return null;
              return (
                <div key={status} className="mb-2">
                  <h4 className="mt-2 text-[14px] font-semibold text-muted">{heading}</h4>
                  <ul className="divide-y divide-rule">
                    {group.map((f) => (
                      <li key={f.requirement} className="py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-[16px]">{f.requirement}</span>
                          <FindingMark status={f.status} />
                        </div>
                        <p className="mt-0.5 text-[13px] text-muted">{f.evidence}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <p className="mt-2 text-[13px] text-muted">
              Evidence comes from Google Shopping listing text and Google product specs, not from the manufacturer. Delivery dates are Google estimates unless confirmed.
            </p>
          </Section>

          <Section title="How it compares">
            {offer.shortlist && (
              <>
                <p className="text-[16px] font-semibold">{offer.shortlist.label}</p>
                <p className="mt-1 text-[16px]">{offer.shortlist.explanation}</p>
                <p className="mt-1 text-[14px] text-muted">{offer.shortlist.status} · {offer.shortlist.compromise}</p>
              </>
            )}
            <p className={offer.shortlist ? "mt-2 text-[14px] text-muted" : "text-[16px]"}>{offer.tradeoff ?? offer.rankNote}</p>
            {offer.unresolved.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[16px]">
                {offer.unresolved.map((u) => <li key={u}>{u}</li>)}
              </ul>
            )}
          </Section>

          <div className="space-y-3 border-t border-rule pt-5">
            {isSafeHttpUrl(offer.url) && (
              <a href={offer.url} target="_blank" rel="noopener noreferrer"
                className="block text-center text-[14px] font-medium text-accent">
                View listing at {offer.seller}
              </a>
            )}
            {lateHard && (
              <p role="alert" className="text-[14px] font-medium text-bad">
                This arrives after your hard deadline, so it doesn&apos;t meet the request as written.
              </p>
            )}
            {offer.eligibility !== "rejected" && !offer.stale ? (
              <Button onClick={choose} disabled={!request.data}>
                {lateHard ? "Choose anyway" : "Select this offer"}
              </Button>
            ) : (
              <p className="text-center text-[13px] text-muted">{offer.stale ? "Out-of-date offers cannot be proposed." : "Rejected offers cannot be proposed."}</p>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
