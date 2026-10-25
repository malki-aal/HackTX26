"use client";

import { useAuth, useClerk, useSignIn } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { CheckingSession, ConfigError, PendingAccess, Unreachable } from "@/components/auth";
import { GoogleButton } from "@/components/google-button";
import { Page, PageHeader, Section } from "@/components/ui";
import { authMode, homeFor } from "@/lib/auth/config";
import { useIdentity } from "@/lib/auth/identity";

const TAGLINE = "Turn purchase requests into approved, evidence-backed buys.";

function Hero() {
  return (
    <PageHeader title="Runway">
      <p className="mt-2 max-w-[30ch] text-[17px] leading-snug text-white/90">{TAGLINE}</p>
    </PageHeader>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<CheckingSession />}>
      <SignInRouter />
    </Suspense>
  );
}

function SignInRouter() {
  if (authMode === "clerk") return <ClerkSignIn />;
  if (authMode === "misconfigured") {
    return (
      <ConfigError message="This build needs NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (and CLERK_SECRET_KEY on the server) before anyone can sign in." />
    );
  }
  // Sample-data demo build: there is no sign-in, and this page says so instead of pretending.
  return (
    <Page>
      <Hero />
      <Section>
        <p className="mb-4 text-[16px]">This build runs on sample data and has no sign-in.</p>
        <Link href="/" className="touch text-[15px] font-medium text-accent">Open the sample app</Link>
      </Section>
    </Page>
  );
}

function ClerkSignIn() {
  const { identity, retry } = useIdentity();
  const { isSignedIn } = useAuth();
  const clerk = useClerk();
  const { signIn, errors } = useSignIn();
  const router = useRouter();
  const params = useSearchParams();
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Already signed in: go straight to the home the server chose for this person.
  useEffect(() => {
    if (identity.status === "ready") router.replace(homeFor(identity.role));
  }, [identity, router]);

  async function start() {
    if (redirecting) return;
    setFailure(null);
    setRedirecting(true);
    try {
      // A rejected session can still look signed in to the provider; drop it first so Google can start clean.
      if (isSignedIn) await clerk.signOut();
      const origin = window.location.origin;
      const { error } = await signIn.sso({
        strategy: "oauth_google",
        redirectUrl: `${origin}/continue`,
        redirectCallbackUrl: `${origin}/sso-callback`,
      });
      if (error) {
        setFailure(error.message || "Couldn’t start Google sign-in.");
        setRedirecting(false);
      }
      // On success the browser leaves for Google; the button keeps saying so.
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Couldn’t start Google sign-in.");
      setRedirecting(false);
    }
  }

  switch (identity.status) {
    case "loading":
      return <CheckingSession />;
    case "ready":
      return <CheckingSession label="Taking you to your home" />;
    case "pending_access":
      return <PendingAccess email={identity.email} />;
    case "unreachable":
      return <Unreachable message={identity.message} />;
    case "misconfigured":
      return <ConfigError message={identity.message} />;
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
    <Page>
      <Hero />
      <Section>
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
        <GoogleButton onClick={start} busy={redirecting} />
        <p className="mt-4 text-[13px] text-muted">
          Use the Google account your team added. Your role is set by Runway’s server, not by anything you choose here.
        </p>
        <div role="status" aria-live="polite" className="sr-only">
          {redirecting ? "Redirecting to Google" : ""}
        </div>
      </Section>
    </Page>
  );
}
