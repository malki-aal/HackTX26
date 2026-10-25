// End-user identity verification. Separate from the eve internal tool-channel token, which never
// reaches browsers. Only the provider's verified claims and profile data are trusted.
import { createClerkClient, verifyToken } from "@clerk/backend";

export interface VerifiedSession {
  providerUserId: string;
  sessionId: string | null;
  expiresAt: number | null;
  authorizedParty: string | null;
}

export interface ProviderProfile {
  providerUserId: string;
  displayName: string;
  primaryEmail: string | null;
  primaryEmailVerified: boolean;
  /** Lower-cased emails the provider reports as verified. Only these can match the allowlist. */
  verifiedEmails: string[];
}

export class AuthError extends Error {
  constructor(public readonly kind: "missing" | "invalid" | "expired" | "not_configured", message: string) {
    super(message);
  }
}

export interface IdentityProvider {
  readonly kind: "clerk" | "test";
  verifySessionToken(token: string): Promise<VerifiedSession>;
  getProfile(providerUserId: string): Promise<ProviderProfile>;
}

/**
 * Clerk session-token verification (signature via JWKS or the PEM key, expiry, and the authorized
 * frontend origins in `azp`), plus profile lookup through the Backend API.
 */
export class ClerkIdentityProvider implements IdentityProvider {
  readonly kind = "clerk" as const;
  private readonly client;

  constructor(private readonly opts: { secretKey: string; jwtKey: string | null; authorizedParties: string[] }) {
    this.client = createClerkClient({ secretKey: opts.secretKey });
  }

  async verifySessionToken(token: string): Promise<VerifiedSession> {
    try {
      const payload = await verifyToken(token, {
        secretKey: this.opts.secretKey,
        ...(this.opts.jwtKey ? { jwtKey: this.opts.jwtKey } : {}),
        authorizedParties: this.opts.authorizedParties,
      });
      if (!payload.sub) throw new AuthError("invalid", "Session token has no subject");
      return {
        providerUserId: payload.sub,
        sessionId: typeof payload.sid === "string" ? payload.sid : null,
        expiresAt: typeof payload.exp === "number" ? payload.exp : null,
        authorizedParty: typeof payload.azp === "string" ? payload.azp : null,
      };
    } catch (e) {
      if (e instanceof AuthError) throw e;
      const reason = String((e as { reason?: string }).reason ?? (e as Error).message ?? "");
      throw new AuthError(/expired/i.test(reason) ? "expired" : "invalid", "Session token could not be verified");
    }
  }

  async getProfile(providerUserId: string): Promise<ProviderProfile> {
    const u = await this.client.users.getUser(providerUserId);
    const verified = u.emailAddresses.filter((e) => e.verification?.status === "verified").map((e) => e.emailAddress.toLowerCase());
    const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || primary?.emailAddress.split("@")[0] || "Runway user";
    return {
      providerUserId: u.id,
      displayName: name.slice(0, 80),
      primaryEmail: primary?.emailAddress.toLowerCase() ?? null,
      primaryEmailVerified: primary?.verification?.status === "verified",
      verifiedEmails: verified,
    };
  }
}

/**
 * Controlled identity provider for automated tests only. It is never constructed by the server;
 * tests inject it through createContext. Tokens look like "test:<providerUserId>[:expired]".
 */
export class TestIdentityProvider implements IdentityProvider {
  readonly kind = "test" as const;
  profiles = new Map<string, ProviderProfile>();

  addUser(providerUserId: string, displayName: string, email: string, verified = true) {
    this.profiles.set(providerUserId, { providerUserId, displayName, primaryEmail: email.toLowerCase(), primaryEmailVerified: verified, verifiedEmails: verified ? [email.toLowerCase()] : [] });
    return `test:${providerUserId}`;
  }

  async verifySessionToken(token: string): Promise<VerifiedSession> {
    const m = /^test:([\w-]+)(:expired)?$/.exec(token);
    if (!m) throw new AuthError("invalid", "Session token could not be verified");
    if (m[2]) throw new AuthError("expired", "Session token could not be verified");
    if (!this.profiles.has(m[1]!)) throw new AuthError("invalid", "Session token could not be verified");
    return { providerUserId: m[1]!, sessionId: null, expiresAt: null, authorizedParty: null };
  }

  async getProfile(providerUserId: string): Promise<ProviderProfile> {
    const p = this.profiles.get(providerUserId);
    if (!p) throw new AuthError("invalid", "Unknown user");
    return structuredClone(p);
  }
}
