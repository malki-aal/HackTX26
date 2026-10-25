"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { formatCents, isSafeHttpUrl } from "@/lib/money";
import {
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
  const [imgFailed, setImgFailed] = useState(false);
  const offer = data?.find((o) => o.id === offerId);

  return (
    <Page>
      <PageHeader title={offer?.title ?? "Offer"} back={{ href: `/requests/${id}`, label: "Offers" }} />
      {loading && <Loading />}
      <ErrorNote error={error} onRetry={reload} />
      {data && !offer && <p className="text-[14px] text-muted">This offer is no longer in the results.</p>}
      {offer && (
        <>
          <p className="-mt-3 mb-4 text-[14px] text-muted">
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
              {offer.delivery && ` ${offer.delivery}.`}
            </p>
          </Section>

          <Section title="Requirements">
            <ul className="divide-y divide-rule">
              {offer.findings.map((f) => (
                <li key={f.requirement} className="py-2.5">
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

          <Section title="Why it ranks here">
            <p className="text-[16px]">{offer.rankNote}</p>
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
            {offer.eligibility !== "rejected" && !offer.stale ? (
              <Link href={`/requests/${id}/proposal?offer=${offer.id}`}
                className="block h-12 rounded-lg bg-accent text-center text-[16px] font-semibold leading-[48px] text-white active:bg-accent-press">
                Use this offer
              </Link>
            ) : (
              <p className="text-center text-[13px] text-muted">{offer.stale ? "Out-of-date offers cannot be proposed." : "Rejected offers cannot be proposed."}</p>
            )}
          </div>
        </>
      )}
    </Page>
  );
}
