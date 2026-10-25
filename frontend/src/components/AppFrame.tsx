"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense } from "react";
import { PUBLIC_PATHS } from "@/lib/auth/config";
import { useIdentity } from "@/lib/auth/identity";

const icon = "h-6 w-6";

function ListIcon() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// Fixed phone-width frame: scrolling content over a bottom tab bar with a raised "new request" button.
// On wide screens it stays centred at phone width so layout never reflows.
export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell flex h-dvh justify-center bg-canvas">
      <div className="app-shell relative flex h-dvh w-full max-w-[430px] flex-col bg-canvas min-[431px]:shadow-[0_0_0_1px_rgba(16,24,40,0.06)]">
        <main className="app-main min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </main>
        <Suspense fallback={<div className="h-16 shrink-0 bg-paper" />}>
          <TabBar />
        </Suspense>
      </div>
    </div>
  );
}

function TabBar() {
  const pathname = usePathname();
  const { identity } = useIdentity();
  if (identity.status !== "ready" || PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return null;
  const requests = pathname === "/" || pathname.startsWith("/requests") || pathname.startsWith("/purchases");
  const account = pathname === "/account" || pathname.startsWith("/executive") || pathname.startsWith("/settings");
  const create = pathname === "/new";

  const tab = (href: string, label: string, active: boolean, glyph: React.ReactNode) => (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex h-16 flex-col items-center justify-center gap-0.5 text-[12px] ${active ? "font-semibold text-accent" : "font-medium text-muted"}`}
    >
      {glyph}
      {label}
    </Link>
  );

  return (
    <nav
      aria-label="Primary"
      className="no-print relative shrink-0 rounded-t-[22px] bg-paper shadow-[0_-4px_16px_rgba(16,24,40,0.08)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-[1fr_72px_1fr] items-end">
        {tab("/", "Requests", requests, <ListIcon />)}
        <div className="flex justify-center">
          <Link
            href="/new"
            aria-label="New request"
            aria-current={create ? "page" : undefined}
            className="-mt-7 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-[0_4px_12px_rgba(79,70,229,0.35)] ring-4 ring-paper active:bg-accent-press"
          >
            <PlusIcon />
          </Link>
        </div>
        {tab("/account", "Account", account, <UserIcon />)}
      </div>
    </nav>
  );
}
