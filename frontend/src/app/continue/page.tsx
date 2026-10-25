"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { CheckingSession } from "@/components/auth";
import { homeFor } from "@/lib/auth/config";
import { useIdentity } from "@/lib/auth/identity";

// After sign-in the server decides where this person goes. The gate above handles pending, expired and
// failure states; once the server has said who this is, route by its role and nothing else.
export default function ContinuePage() {
  const { identity } = useIdentity();
  const router = useRouter();
  useEffect(() => {
    if (identity.status === "ready") router.replace(homeFor(identity.role));
  }, [identity, router]);
  return <CheckingSession label="Checking your access" />;
}
