"use client";

import { HandleSSOCallback } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { CheckingSession, ConfigError } from "@/components/auth";
import { authMode } from "@/lib/auth/config";

// Google sends the browser back here. Clerk finishes the session, then we hand off to /continue,
// which asks the server who this is and routes by its answer.
export default function SsoCallbackPage() {
  const router = useRouter();
  if (authMode !== "clerk") {
    return <ConfigError message="Sign-in isn’t configured, so there is nothing to finish here." />;
  }
  return (
    <>
      <CheckingSession label="Finishing sign-in" />
      {/* A first sign-in creates the account here; Clerk's bot protection may need to show a challenge. */}
      <div id="clerk-captcha" className="mx-auto max-w-[430px] px-4 empty:hidden" />
      <HandleSSOCallback
        navigateToApp={({ decorateUrl }) => {
          const destination = decorateUrl("/continue");
          if (destination.startsWith("http")) window.location.href = destination;
          else router.replace(destination);
        }}
        navigateToSignIn={() => router.replace("/sign-in?error=failed")}
        navigateToSignUp={() => router.replace("/sign-in?error=failed")}
      />
    </>
  );
}
