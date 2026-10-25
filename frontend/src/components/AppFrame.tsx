"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, type BackendMode } from "@/lib/api";

const tabs = [
  { href: "/", label: "Requests", match: (p: string) => p === "/" || p.startsWith("/requests") },
  { href: "/new", label: "New request", match: (p: string) => p === "/new" },
  { href: "/account", label: "Account", match: (p: string) => p === "/account" },
];

// Fixed phone-width frame: header strip, scrolling content, bottom tab bar.
// On wide screens it stays centred at phone width so layout never reflows.
function DataLabel() {
  const [backend, setBackend] = useState<BackendMode | null>(null);
  useEffect(() => {
    let alive = true;
    void api.getBackendMode().then((m) => alive && setBackend(m));
    return () => {
      alive = false;
    };
  }, []);
  if (backend === null) return null;
  if (backend === "offline") return <span className="font-medium text-bad">Backend unreachable</span>;
  if (backend === "fixtures" || api.mode === "fixture") return <span className="font-medium text-ink">Sample data</span>;
  return <span className="font-medium text-ink">Live data</span>;
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh justify-center bg-paper">
      <div className="flex h-dvh w-full max-w-[430px] flex-col border-rule min-[431px]:border-x">
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-b border-rule bg-raised px-5 pb-2 text-[13px] text-muted"
          style={{ paddingTop: "max(env(safe-area-inset-top), 8px)" }}
        >
          <span>Demo role: Employee</span>
          <DataLabel />
        </div>
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</main>
        <Suspense fallback={<div className="h-14 shrink-0 border-t border-rule" />}>
          <TabBar />
        </Suspense>
      </div>
    </div>
  );
}

function TabBar() {
  const pathname = usePathname();
  return (
        <nav
          aria-label="Primary"
          className="shrink-0 border-t border-rule bg-paper"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <ul className="grid grid-cols-3">
            {tabs.map((t) => {
              const active = t.match(pathname);
              return (
                <li key={t.href}>
                  <Link
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex h-14 items-center justify-center text-[14px] ${
                      active ? "font-semibold text-accent" : "text-muted"
                    }`}
                  >
                    {active && <span className="absolute inset-x-6 top-0 h-[2px] bg-accent" />}
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
  );
}
