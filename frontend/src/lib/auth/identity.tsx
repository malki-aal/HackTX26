"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { createContext, Fragment, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api, type ApiError } from "@/lib/api";
import { authMode } from "./config";
import { UNAUTHORIZED_EVENT, setTokenProvider } from "./token";

export type Role = "employee" | "executive";

export type Identity =
  /** Clerk is loading, or the backend is checking who this is. */
  | { status: "loading" }
  | { status: "signed_out" }
  /** The backend rejected the session (401 UNAUTHENTICATED). */
  | { status: "expired" }
  /** No sign-in provider is configured where one is required. Never a fake login. */
  | { status: "misconfigured"; message: string }
  | { status: "unreachable"; message: string }
  | { status: "unavailable"; message: string }
  | { status: "pending_access"; name: string | null; email: string | null }
  | {
      status: "ready";
      kind: "demo" | "signed_in";
      /** From the server only (`GET /me`), or a label in sample-data demo mode. */
      role: Role;
      name: string;
      email: string | null;
      company: string;
      userId: string | null;
    };

interface IdentityApi {
  identity: Identity;
  signOut: (() => void) | null;
  /** Ask the server again who this is (after a failure). */
  retry: (() => void) | null;
  /** Demo mode only: switch the label between Employee and Executive. */
  switchRole: ((r: Role) => void) | null;
}

const Ctx = createContext<IdentityApi>({ identity: { status: "loading" }, signOut: null, retry: null, switchRole: null });
export const useIdentity = () => useContext(Ctx);

/** A person's data must not outlive their session in a shared browser. */
function clearPersonalBrowserState() {
  try {
    for (const store of [window.sessionStorage, window.localStorage]) {
      for (const k of Object.keys(store)) if (k.startsWith("runway.")) store.removeItem(k);
    }
  } catch {}
}

/** Remounting on identity change drops component state, caches held in components and polling timers. */
function Keyed({ id, children }: { id: string; children: React.ReactNode }) {
  return <Fragment key={id}>{children}</Fragment>;
}

// ---------------- demo (sample-data mode only) ----------------

const DEMO_ROLE_KEY = "runway.demoRole";
const roleListeners = new Set<() => void>();
function readDemoRole(): Role {
  try {
    return window.sessionStorage.getItem(DEMO_ROLE_KEY) === "executive" ? "executive" : "employee";
  } catch {
    return "employee";
  }
}
function writeDemoRole(r: Role) {
  try {
    window.sessionStorage.setItem(DEMO_ROLE_KEY, r);
  } catch {}
  roleListeners.forEach((l) => l());
}
function subscribeRole(l: () => void) {
  roleListeners.add(l);
  return () => {
    roleListeners.delete(l);
  };
}

function DemoProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const stored = useSyncExternalStore(subscribeRole, readDemoRole, () => "employee" as Role);
  const onExecutivePage = pathname.startsWith("/executive");
  // Opening the approvals screens makes the demo role Executive and keeps it until it is switched back.
  useEffect(() => {
    if (onExecutivePage) writeDemoRole("executive");
  }, [onExecutivePage]);
  const role: Role = onExecutivePage ? "executive" : stored;
  const value = useMemo<IdentityApi>(
    () => ({
      identity: {
        status: "ready",
        kind: "demo",
        role,
        name: role === "executive" ? "Executive" : "Employee",
        email: null,
        company: "Demo company",
        userId: null,
      },
      signOut: null,
      retry: null,
      switchRole: writeDemoRole,
    }),
    [role],
  );
  return (
    <Ctx.Provider value={value}>
      <Keyed id="demo">{children}</Keyed>
    </Ctx.Provider>
  );
}

function MisconfiguredProvider({ children }: { children: React.ReactNode }) {
  const value = useMemo<IdentityApi>(
    () => ({
      identity: {
        status: "misconfigured",
        message:
          "Sign-in isn’t configured. This build needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (and CLERK_SECRET_KEY on the server) before anyone can sign in.",
      },
      signOut: null,
      retry: null,
      switchRole: null,
    }),
    [],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ---------------- Clerk ----------------

function errorCode(e: unknown): string {
  return e && typeof e === "object" && "code" in e ? String((e as ApiError).code) : "";
}

function ClerkProviderBridge({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const [me, setMe] = useState<Identity | null>(null);
  const [expired, setExpired] = useState(false);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const lastUser = useRef<string | null>(null);

  // If the provider script never loads (blocked network, wrong key), say so instead of spinning forever.
  useEffect(() => {
    if (isLoaded) return;
    const t = setTimeout(() => setSlow(true), 12000);
    return () => clearTimeout(t);
  }, [isLoaded]);

  // The adapter asks for a fresh token on every call.
  useEffect(() => {
    setTokenProvider(isSignedIn ? () => getToken() : null);
    return () => setTokenProvider(null);
  }, [isSignedIn, getToken]);

  useEffect(() => {
    const onExpired = () => setExpired(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onExpired);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpired);
  }, []);

  // Different person, different data.
  useEffect(() => {
    if (!isLoaded) return;
    const current = isSignedIn ? (userId ?? null) : null;
    if (lastUser.current !== null && lastUser.current !== current) clearPersonalBrowserState();
    lastUser.current = current;
  }, [isLoaded, isSignedIn, userId]);

  // Role, membership and company come from the backend, never from the client, a picker or the avatar.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;
    api
      .getMe()
      .then((m) => {
        if (!alive) return;
        setExpired(false);
        if (m.status === "pending" || !m.role) {
          setMe({ status: "pending_access", name: m.displayName, email: m.email });
        } else {
          setMe({ status: "ready", kind: "signed_in", role: m.role, name: m.displayName, email: m.email, company: m.company?.name ?? "", userId: m.userId });
        }
      })
      .catch((e) => {
        if (!alive) return;
        const code = errorCode(e);
        const message = (e as ApiError)?.message ?? "Couldn’t check your access.";
        if (code === "UNAUTHENTICATED" || code === "HTTP_401") setExpired(true);
        else if (code === "ACCESS_PENDING")
          setMe({ status: "pending_access", name: user?.fullName ?? null, email: user?.primaryEmailAddress?.emailAddress ?? null });
        else if (code === "BACKEND_UNREACHABLE") setMe({ status: "unreachable", message });
        else if (code === "AUTH_NOT_CONFIGURED")
          setMe({ status: "unavailable", message: "The server isn’t set up for sign-in yet. Ask whoever runs the backend to add its Clerk keys." });
        else setMe({ status: "unavailable", message });
      });
    return () => {
      alive = false;
    };
  }, [isLoaded, isSignedIn, user, attempt]);

  const identity = useMemo<Identity>(
    () =>
      !isLoaded
        ? slow
          ? { status: "unavailable", message: "The sign-in service didn’t load. Check the network and the Clerk keys in the setup notes, then reload." }
          : { status: "loading" }
        : !isSignedIn
          ? { status: expired ? "expired" : "signed_out" }
          : expired
            ? { status: "expired" }
            : (me ?? { status: "loading" }),
    [isLoaded, isSignedIn, expired, me, slow],
  );

  // Sign out clears what was cached for this person, drops the session, and lands back on the sign-in page.
  const signOut = useCallback(() => {
    clearPersonalBrowserState();
    void clerk.signOut({ redirectUrl: "/sign-in" });
  }, [clerk]);
  const retry = useCallback(() => {
    setMe(null);
    setAttempt((n) => n + 1);
  }, []);

  const value = useMemo<IdentityApi>(() => ({ identity, signOut, retry, switchRole: null }), [identity, signOut, retry]);
  const key = identity.status === "ready" && identity.userId ? identity.userId : identity.status;
  return (
    <Ctx.Provider value={value}>
      <Keyed id={key}>{children}</Keyed>
    </Ctx.Provider>
  );
}

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  if (authMode === "clerk") return <ClerkProviderBridge>{children}</ClerkProviderBridge>;
  if (authMode === "misconfigured") return <MisconfiguredProvider>{children}</MisconfiguredProvider>;
  // usePathname needs a Suspense boundary in a statically built app.
  return (
    <Suspense fallback={<div className="h-dvh bg-hero" />}>
      <DemoProvider>{children}</DemoProvider>
    </Suspense>
  );
}
