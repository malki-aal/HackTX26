"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, type ApiError } from "@/lib/api";
import { formatCents } from "@/lib/money";
import { Button, ErrorNote, Loading, Page, PageHeader, Section, normalizeError, useLoad, usePolling } from "@/components/ui";

export default function ProjectPage() {
  return <Suspense fallback={<Page><Loading /></Page>}><Project /></Suspense>;
}

function Project() {
  const { id } = useParams<{ id: string }>();
  const project = useLoad(() => api.getProject(id), [id]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState("");
  const p = project.data;
  usePolling(project.refresh, 4000, !!p?.lines.some((line) => line.research?.runStatus === "running" || line.status === "researching"));
  const ready = p?.lines.filter((line) => !line.unansweredQuestionIds.length && ["draft", "ready_to_confirm", "confirmed", "awaiting_confirmation"].includes(line.status)) ?? [];

  async function search() {
    if (pending) return;
    setPending(true); setError(null); setNotice("");
    try {
      const response = await api.startProjectResearch(id);
      const started = response.results.filter((line) => line.result === "started").length;
      const skipped = response.results.filter((line) => line.result !== "started").length;
      setNotice(`${started} item searches started.${skipped ? ` ${skipped} could not start; open those items to review.` : ""}`);
      await project.refresh();
    } catch (e) { setError(normalizeError(e)); }
    finally { setPending(false); }
  }

  return <Page>
    <PageHeader title={p?.title ?? "Grouped request"} back={{ href: "/", label: "Requests" }} amount={p?.budgetCents} amountLabel="Total budget" />
    {project.loading && <Loading />}
    <ErrorNote error={project.error} onRetry={project.reload} />
    {p && <>
      {p.purpose && <Section title="Purpose"><p>{p.purpose}</p></Section>}
      <Section title="Items">
        <p className="mb-3 text-[13px] text-muted">Each item has its own search and approval, within this project&apos;s total budget.</p>
        <ul className="divide-y divide-rule">{p.lines.map((line) => {
          const needsDetails = line.unansweredQuestionIds.length > 0;
          const working = line.status === "researching";
          const readyToSearch = ready.some((r) => r.key === line.key);
          return <li key={line.key} className="py-4">
            <div className="flex justify-between gap-3"><h2 className="font-semibold">{line.quantity} × {line.title}</h2><span>{formatCents(line.lineBudgetCents)}</span></div>
            <Link href={`/requests/${line.requestId}`} className="mt-2 inline-block font-medium text-accent">{needsDetails ? "Answer a few details" : working ? "View search progress" : readyToSearch ? "Review item" : "View options and status"} →</Link>
          </li>;
        })}</ul>
      </Section>
      <ErrorNote error={error} />
      {notice && <p role="status" className="mb-3 text-[14px]">{notice}</p>}
      {!!ready.length && <><Button disabled={pending} onClick={search}>{pending ? "Starting…" : `Find options for ${ready.length} item types`}</Button><p className="mt-2 text-[12px] text-muted">Confirms ready items and starts a separate quota-using search for each.</p></>}
    </>}
  </Page>;
}
