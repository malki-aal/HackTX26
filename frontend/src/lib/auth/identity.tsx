"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { createContext, Fragment, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiError } from "@/lib/api";
import { authMode } from "./config";
import { UNAUTHORIZED_EVENT, setTokenProvider } from "./token";

export type Role = "employee" | "executive";

export type Identity =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "expired" }
  | { status: "unavailable"; message: string }
  | { status: "pending_access"; name: string | null; email: string | null }
  | {
      status: "ready";
      kind: "demo" | "signed_in";
      role: Role;
      name: string;
      email: string | null;
      company: string;
      userId: string | null;
    };

interface IdentityApi {
  identity: Identity;
  signIn: (() => void) | null;
  signOut: (() => void) | null;
}

const Ctx = createContext<IdentityApi>({ identity: { status: "loading" }, signIn: null, signOut: null });
export const useIdentity = () => useContext(Ctx);

/** A person's data must not outlive their session in a shared browser. */
function clearPersonalBrowserState() {
  try {
    for (const store of [window.sessionStorage, window.localStorage]) {
      for (const k of Object.keys(store)) if (k.startsWith("runway.selection.")) store.removeItem(k);
    }
  } catch {}
}

/** Remounting on identity change drops component state, caches held in components and polling timers. */
function Keyed({ id, children }: { id: string; children: React.ReactNode }) {
  return <Fragment key={id}>{children}</Fragment>;
}

// ---------------- demo (no sign-in provider) ----------------

function DemoProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const role: Role = pathname.startsWith("/executive") ? "executive" : "employee";
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
      signIn: null,
      signOut: null,
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
        status: "unavailable",
        message: "Sign-in is required here, but no sign-in provider is configured. Set the publishable key described in the handoff.",
      },
      signIn: null,
      signOut: null,
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

  // Role and company come from the backend, never from the client or the avatar.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let alive = true;
    api
      .getMe()
      .then((m) => {
        if (!alive) return;
        setExpired(false);
        setMe({ status: "ready", kind: "signed_in", role: m.role, name: m.displayName, email: m.email, company: m.company.name, userId: m.userId });
      })
      .catch((e) => {
        if (!alive) return;
        const code = errorCode(e);
        if (code === "HTTP_401") setExpired(true);
        else if (code === "HTTP_403" || code === "NO_MEMBERSHIP" || code === "FORBIDDEN")
          setMe({ status: "pending_access", name: user?.fullName ?? null, email: user?.primaryEmailAddress?.emailAddress ?? null });
        else if (code === "HTTP_404" || code === "NOT_FOUND")
          setMe({ status: "unavailable", message: "You are signed in, but the backend does not support verified sign-in yet (it has no /me endpoint), so access can’t be checked." });
        else setMe({ status: "unavailable", message: (e as ApiError)?.message ?? "Couldn’t check your access." });
      });
    return () => {
      alive = false;
    };
  }, [isLoaded, isSignedIn, user]);

  const identity = useMemo<Identity>(
    () =>
      !isLoaded
        ? slow
          ? { status: "unavailable", message: "The sign-in service didn’t load. Check the network and the Clerk keys in the setup notes, then reload." }
          : { status: "loading" }
        : !isSignedIn
          ? { status: "signed_out" }
          : expired
            ? { status: "expired" }
            : (me ?? { status: "loading" }),
    [isLoaded, isSignedIn, expired, me, slow],
  );

  const signIn = useCallback(() => clerk.openSignIn({}), [clerk]);
  const signOut = useCallback(() => {
    clearPersonalBrowserState();
    void clerk.signOut();
  }, [clerk]);

  const value = useMemo<IdentityApi>(() => ({ identity, signIn, signOut }), [identity, signIn, signOut]);
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
