// Auth mode is fixed at build time from public configuration (a publishable key is meant for the browser;
// the secret key is read only by the server and never appears here).
export const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/** Live deployments can insist on sign-in; without a provider that is a configuration error, not a fallback. */
export const authRequired = process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true";

export type AuthMode = "clerk" | "demo" | "misconfigured";
export const authMode: AuthMode = clerkEnabled ? "clerk" : authRequired ? "misconfigured" : "demo";
