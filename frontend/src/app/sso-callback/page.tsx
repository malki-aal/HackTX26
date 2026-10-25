"use client";

import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { CheckingSession, ConfigError } from "@/components/auth";
import { authMode } from "@/lib/auth/config";

// Google sends the browser back here. Clerk finishes the sign-in (or creates the account on a first
// sign-in), then we hand off to /continue, which asks the server who this is and routes by its answer.
export default function SsoCallbackPage() {
  if (authMode !== "clerk") {
    return <ConfigError message="Sign-in isn’t configured, so there is nothing to finish here." />;
  }
  return (
    <>
      <CheckingSession label="Finishing sign-in" />
      {/* A first sign-in creates the account here; Clerk's bot protection may need to show a challenge. */}
      <div id="clerk-captcha" className="mx-auto max-w-[430px] px-4 empty:hidden" />
      <AuthenticateWithRedirectCallback
        signInForceRedirectUrl="/continue"
        signUpForceRedirectUrl="/continue"
        signInFallbackRedirectUrl="/continue"
        signUpFallbackRedirectUrl="/continue"
        continueSignUpUrl="/sign-in?error=failed"
      />
    </>
  );
}
