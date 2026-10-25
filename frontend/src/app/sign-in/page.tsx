"use client";

import { useAuth, useClerk, useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CheckingSession, ConfigError, PendingAccess, Unreachable } from "@/components/auth";
import { GoogleButton } from "@/components/google-button";
import { SignInStage } from "@/components/sign-in-stage";
import { authMode, homeFor } from "@/lib/auth/config";
import { useIdentity } from "@/lib/auth/identity";
import { signInErrorMessage } from "@/lib/auth/sign-in-errors";

const TAGLINE = "Helping employee ideas get off the ground.";

// Clerk's development instance has taken over 20 s to start a sign-in, so allow that before calling it stalled.
const REDIRECT_TIMEOUT_MS = 25000;
/** Most a stale-session sign-out may delay sign-in. */
const SIGN_OUT_LIMIT_MS = 4000;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Browsers built into other apps. Google refuses OAuth sign-in inside them. */
const IN_APP_UA = /FBAN|FBAV|FB_IAB|Instagram|Snapchat|LinkedInApp|Line\/|MicroMessenger|TikTok|musical_ly|Twitter|Discord|GroupMe/i;
const isInAppBrowser = () => IN_APP_UA.test(navigator.userAgent);
const noSubscribe = () => () => {};

/** Status screens (checking, pending, unreachable…) keep the narrow phone layout inside the full-screen page. */
function Narrow({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto min-h-dvh max-w-[430px]">{children}</div>;
}

/** Full-screen landing: headline and the sign-in card over the interactive backdrop. */
function Landing({ children }: { children: React.ReactNode }) {
  return (
    <SignInStage>
      <div className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col px-6 sm:px-10" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <main className="grid flex-1 items-center gap-10 py-10 sm:py-16 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <section className="w-fit max-w-full rounded-2xl bg-[rgba(20,83,45,0.82)] p-6 text-white shadow-[0_12px_32px_rgba(20,83,45,0.25)] sm:p-8">
            <h1 className="text-[clamp(48px,8vw,96px)] font-extrabold leading-[0.95] tracking-[-0.03em]">Runway</h1>
            <p className="mt-4 max-w-[24ch] text-balance text-[clamp(18px,2.2vw,26px)] font-semibold leading-snug tracking-tight">{TAGLINE}</p>
          </section>
          <section className="w-full max-w-[440px] justify-self-center rounded-2xl bg-paper p-6 border border-rule shadow-[0_12px_32px_rgba(20,35,26,0.08)] sm:p-8 lg:justify-self-end">
            {children}
          </section>
        </main>
      </div>
    </SignInStage>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<Narrow><CheckingSession /></Narrow>}>
      <SignInRouter />
    </Suspense>
  );
}

function SignInRouter() {
  if (authMode === "clerk") return <ClerkSignIn />;
  if (authMode === "misconfigured") {
    return (
      <Narrow>
        <ConfigError message="This build needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (and CLERK_SECRET_KEY on the server) before anyone can sign in." />
      </Narrow>
    );
  }
  // Sample-data demo build: there is no sign-in, and this page says so instead of pretending.
  return (
    <Landing>
      <h2 className="mb-2 text-[24px] font-bold tracking-tight">Sample data</h2>
      <p className="mb-4 text-[16px] text-muted">This build runs on sample data and has no sign-in.</p>
      <Link href="/" className="touch text-[15px] font-medium text-accent">Open the sample app</Link>
    </Landing>
  );
}

function ClerkSignIn() {
  const { identity, retry } = useIdentity();
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const { errors } = useSignIn();
  const router = useRouter();
  const params = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inAppBrowser = useSyncExternalStore(noSubscribe, isInAppBrowser, () => false);

  // Already signed in: go straight to the home the server chose for this person.
  useEffect(() => {
    if (identity.status === "ready") router.replace(homeFor(identity.role));
  }, [identity, router]);

  // The step the sign-in reached, so a stall can say where it stopped.
  const stepRef = useRef("starting");
  // Synchronous lock: React state updates too late to stop a fast double tap from starting two
  // sign-ins (each one costs a request to Clerk's rate-limited development service).
  const startingRef = useRef(false);

  // If the browser hasn't left for Google after a while, stop waiting and say why instead of spinning
  // forever. A tab in the background is checked again when it becomes visible, never left stuck.
  useEffect(() => {
    if (!redirecting) return;
    const stalled = () => {
      startingRef.current = false;
      setRedirecting(false);
      setFailure(
        inAppBrowser
          ? "Google didn’t open. This page is open inside another app, and Google blocks sign-in there. Open it in Safari or Chrome and try again."
          : `Google didn’t open (stopped while ${stepRef.current}). The sign-in service may be slow; wait a moment, then try again once.`,
      );
    };
    let onVisible: (() => void) | null = null;
    const t = setTimeout(() => {
      if (document.visibilityState !== "hidden") return stalled();
      onVisible = () => {
        if (document.visibilityState === "visible") stalled();
      };
      document.addEventListener("visibilitychange", onVisible);
    }, REDIRECT_TIMEOUT_MS);
    return () => {
      clearTimeout(t);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [redirecting, inAppBrowser]);

  async function start() {
    if (startingRef.current || redirecting) return;
    startingRef.current = true;
    setFailure(null);
    setRedirecting(true);
    try {
      // A rejected session can still look signed in to the provider; drop it first so Google can start clean.
      // Never let that step hold up sign-in.
      if (isSignedIn) {
        stepRef.current = "clearing an old session";
        await Promise.race([clerk.signOut(), wait(SIGN_OUT_LIMIT_MS)]);
      }
      const signInResource = clerk.client?.signIn;
      if (!signInResource) {
        stepRef.current = "loading Clerk";
        throw new Error("Sign-in isn’t ready yet. Reload the page and try again.");
      }
      // Clerk's redirect flow: it records the Google strategy and sends the browser to Google itself.
      // (The newer signIn.sso() returned without redirecting on several devices.)
      stepRef.current = "waiting for Clerk";
      const origin = window.location.origin;
      await signInResource.authenticateWithRedirect({
        strategy: "oauth_google",
        redirectUrl: `${origin}/sso-callback`,
        redirectUrlComplete: `${origin}/continue`,
      });
      stepRef.current = "opening Google";
    } catch (e) {
      startingRef.current = false;
      setFailure(signInErrorMessage(e));
      setRedirecting(false);
    }
  }

  switch (identity.status) {
    case "loading":
      return <Narrow><CheckingSession /></Narrow>;
    case "ready":
      return <Narrow><CheckingSession label="Taking you to your home" /></Narrow>;
    case "pending_access":
      return <Narrow><PendingAccess email={identity.email} /></Narrow>;
    case "unreachable":
      return <Narrow><Unreachable message={identity.message} /></Narrow>;
    case "misconfigured":
      return <Narrow><ConfigError message={identity.message} /></Narrow>;
    default:
      break;
  }

  const expired = identity.status === "expired" || params.get("reason") === "expired";
  const unavailable = identity.status === "unavailable" ? identity.message : null;
  const returned = params.get("error");
  const banner =
    failure ??
    errors.global?.[0]?.message ??
    (returned === "cancelled"
      ? "Sign-in was cancelled. Try again when you’re ready."
      : returned
        ? "Sign-in didn’t finish. Try again."
        : unavailable);

  return (
    <Landing>
      <h2 className="mb-1 text-[24px] font-bold tracking-tight">Sign in</h2>
      <p className="mb-5 text-[15px] text-muted">Use the Google account your team added.</p>
      {expired && !banner && (
        <p role="status" className="mb-4 rounded-xl bg-accent-soft p-3 text-[14px]">
          Your session ended. Sign in again to continue.
        </p>
      )}
      {banner && (
        <div role="alert" className="mb-4 rounded-xl border-l-4 border-bad bg-bad-soft p-3 text-[14px]">
          <p className="font-medium text-bad">{banner}</p>
          {unavailable && !failure && !returned && (
            <button type="button" onClick={() => retry?.()} className="touch text-[15px] font-medium text-accent">
              Check again
            </button>
          )}
        </div>
      )}
      {inAppBrowser && !banner && (
        <p role="status" className="mb-4 rounded-xl bg-orange-soft p-3 text-[14px] text-ink">
          This page is open inside another app. Google blocks sign-in there, so open it in Safari or Chrome first.
        </p>
      )}
      <GoogleButton onClick={start} busy={redirecting} />
      <div role="status" aria-live="polite" className="sr-only">
        {redirecting ? "Redirecting to Google" : ""}
      </div>
    </Landing>
  );
}
