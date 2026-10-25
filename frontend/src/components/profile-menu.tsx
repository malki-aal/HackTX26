"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/avatars";
import { useIdentity } from "@/lib/auth/identity";

/** Circular profile control with the account details people are entitled to see. */
export function ProfileMenu() {
  const { identity, signOut } = useIdentity();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (identity.status !== "ready") return null;
  const label = identity.role === "executive" ? "Executive" : "Employee";

  return (
    <div ref={wrap} className="no-print absolute right-5" style={{ top: "calc(env(safe-area-inset-top) + 12px)" }}>
      <button
        type="button"
        aria-label={`Profile menu, ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-hero-tile"
      >
        <Avatar role={identity.role} size={36} />
      </button>
      {open && (
        <div role="dialog" aria-label="Profile" className="absolute right-0 z-20 mt-2 w-[270px] rounded-2xl bg-paper p-4 text-ink shadow-[0_8px_30px_rgba(16,24,40,0.2)]">
          <div className="flex items-center gap-3">
            <Avatar role={identity.role} size={44} />
            <div className="min-w-0">
              <p className="truncate text-[16px] font-semibold">{identity.kind === "demo" ? `${label} (demo role)` : identity.name}</p>
              {identity.email && <p className="truncate text-[13px] text-muted">{identity.email}</p>}
            </div>
          </div>
          <dl className="mt-3 text-[14px]">
            <div className="flex justify-between py-1"><dt className="text-muted">Role</dt><dd className="font-medium">{label}</dd></div>
            <div className="flex justify-between py-1"><dt className="text-muted">Company</dt><dd className="font-medium">{identity.company}</dd></div>
          </dl>
          {identity.kind === "demo" && (
            <p className="mt-2 text-[13px] text-muted">
              A label for the demo. There is no sign-in, and this role protects nothing.
            </p>
          )}
          <div className="mt-3 border-t border-rule pt-1">
            <Link href="/account" onClick={() => setOpen(false)} className="touch w-full text-[15px] font-medium text-accent">Account</Link>
            {identity.kind === "demo" && (
              <Link
                href={identity.role === "executive" ? "/" : "/executive"}
                onClick={() => setOpen(false)}
                className="touch w-full text-[15px] font-medium text-accent"
              >
                {identity.role === "executive" ? "Switch to the Employee view" : "Switch to the Executive view"}
              </Link>
            )}
            {signOut && (
              <button type="button" onClick={() => signOut()} className="touch w-full text-[15px] font-medium text-accent">
                Sign out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
