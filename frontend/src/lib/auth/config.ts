// Auth mode is fixed at build time from public configuration (a publishable key is meant for the browser;
// the secret key is read only by the server and never appears here).
export const clerkEnabled = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * Real sign-in is required whenever the app talks to the live backend (the backend refuses demo identities
 * there too), or when a deployment asks for it. Without a provider that is a configuration error, never a fake login.
 * Demo labels exist only for the in-browser sample-data mode.
 */
export const authRequired = process.env.NEXT_PUBLIC_REQUIRE_AUTH === "true" || process.env.NEXT_PUBLIC_API_MODE === "live";

export type AuthMode = "clerk" | "demo" | "misconfigured";
export const authMode: AuthMode = clerkEnabled ? "clerk" : authRequired ? "misconfigured" : "demo";

/** Where each verified role starts. The role itself only ever comes from the server. */
export const homeFor = (role: "employee" | "executive") => (role === "executive" ? "/executive" : "/");

/** Routes that must stay reachable while signed out. */
export const PUBLIC_PATHS = ["/sign-in", "/sso-callback"];
