"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { PUBLIC_PATHS } from "@/lib/auth/config";
import { useIdentity, type Role } from "@/lib/auth/identity";
import { Button, Loading, Page, PageHeader, Section } from "@/components/ui";

export function GateScreen({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
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

export function CheckingSession({ label = "Checking your session" }: { label?: string }) {
  return (
    <Page>
      <PageHeader title="Runway" />
      <Loading label={label} />
    </Page>
  );
}

/** Signed in with a Google account the server does not list. Nothing else is reachable. */
export function PendingAccess({ email }: { email: string | null }) {
  const { signOut } = useIdentity();
  return (
    <GateScreen title="Access pending" body="Ask your admin to add this Google account.">
      {email && (
        <p className="mb-4 text-[15px]">
          Signed in as <span className="font-semibold">{email}</span>
        </p>
      )}
      <Button variant="quiet" onClick={() => signOut?.()}>
        Sign out
      </Button>
    </GateScreen>
  );
}

export function ConfigError({ message }: { message: string }) {
  return (
    <GateScreen title="Sign-in isn’t set up" body={message}>
      <p className="text-[14px] text-muted">
        Add the keys to <code>frontend/.env.local</code>, rebuild, and reload. Keys are never shown here.
      </p>
    </GateScreen>
  );
}

export function Unreachable({ message }: { message: string }) {
  const { retry } = useIdentity();
  return (
    <GateScreen title="Can’t reach the server" body={message}>
      <Button onClick={() => (retry ? retry() : window.location.reload())}>Try again</Button>
    </GateScreen>
  );
}

/**
 * Protects a view in signed-in mode. Hiding a button is not security; the backend checks every request.
 * The sign-in and Google-return routes stay open. In sample-data demo mode (no provider) every view is open
 * and the role is only a label.
 */
export function AuthGate({ need, children }: { need?: Role; children: React.ReactNode }) {
  const { identity, signOut } = useIdentity();
  const pathname = usePathname();
  const router = useRouter();
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const signedOut = identity.status === "signed_out" || identity.status === "expired";

  // Back to the sign-in page, remembering why when the session ended.
  useEffect(() => {
    if (isPublic || !signedOut) return;
    router.replace(identity.status === "expired" ? "/sign-in?reason=expired" : "/sign-in");
  }, [isPublic, signedOut, identity.status, router]);

  if (isPublic) return <>{children}</>;

  switch (identity.status) {
    case "loading":
      return <CheckingSession />;
    case "signed_out":
    case "expired":
      return <CheckingSession label="Taking you to sign in" />;
    case "misconfigured":
      return <ConfigError message={identity.message} />;
    case "unreachable":
      return <Unreachable message={identity.message} />;
    case "unavailable":
      return (
        <GateScreen title="Can’t verify access" body={identity.message}>
          {signOut && <Button variant="quiet" onClick={() => signOut()}>Sign out</Button>}
        </GateScreen>
      );
    case "pending_access":
      return <PendingAccess email={identity.email} />;
    case "ready":
      if (need && identity.role !== need) {
        return (
          <GateScreen title="No approval access" body="Only executives can review and decide on proposals. Your role doesn’t include that.">
            <Link href="/" className="touch text-[15px] font-medium text-accent">Back to requests</Link>
          </GateScreen>
        );
      }
      return <>{children}</>;
  }
}
