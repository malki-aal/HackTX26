"use client";

import Link from "next/link";
import { useIdentity, type Role } from "@/lib/auth/identity";
import { Button, Loading, Page, PageHeader, Section } from "@/components/ui";

function GateScreen({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <Page>
      <PageHeader title={title} />
      <Section>
        <p className="mb-4 text-[16px]">{body}</p>
        {children}
      </Section>
    </Page>
  );
}

/**
 * Protects a view in signed-in mode. Hiding a button is not security; the backend must check every request.
 * In demo mode (no provider) every view is open and the role is only a label.
 */
export function AuthGate({ need, children }: { need?: Role; children: React.ReactNode }) {
  const { identity, signIn, signOut } = useIdentity();

  switch (identity.status) {
    case "loading":
      return <Page><PageHeader title="Runway" /><Loading label="Checking your session" /></Page>;
    case "signed_out":
      return (
        <GateScreen title="Sign in" body="Sign in with your Google account to use Runway.">
          <Button onClick={() => signIn?.()}>Sign in with Google</Button>
        </GateScreen>
      );
    case "expired":
      return (
        <GateScreen title="Session ended" body="Your session expired or was rejected. Sign in again to continue.">
          <div className="space-y-3">
            <Button onClick={() => signIn?.()}>Sign in again</Button>
            <Button variant="quiet" onClick={() => signOut?.()}>Sign out</Button>
          </div>
        </GateScreen>
      );
    case "unavailable":
      return (
        <GateScreen title="Can’t verify access" body={identity.message}>
          {signOut && <Button variant="quiet" onClick={() => signOut()}>Sign out</Button>}
        </GateScreen>
      );
    case "pending_access":
      return (
        <GateScreen
          title="Access pending"
          body={`${identity.email ?? "This account"} is signed in but isn’t a member of a company yet. Ask your team to add this Google email, then sign in again.`}
        >
          <Button variant="quiet" onClick={() => signOut?.()}>Sign out</Button>
        </GateScreen>
      );
    case "ready":
      if (need && identity.role !== need) {
        return (
          <GateScreen
            title="No approval access"
            body="Only executives can review and decide on proposals. Your role doesn’t include that."
          >
            <Link href="/" className="touch text-[15px] font-medium text-accent">Back to requests</Link>
          </GateScreen>
        );
      }
      return <>{children}</>;
  }
}
