// Request principals, server-owned memberships and the team-supplied bootstrap allowlist.
// A Google sign-in proves who the user is; company and role come only from the allowlist file
// that the team controls on the server. Nothing the browser sends can change them.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { json, nowIso, tx } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { AuthError, type ProviderProfile } from "./identity.js";

export type Role = "employee" | "executive";

export interface Principal {
  kind: "demo" | "user";
  userId: string;
  displayName: string;
  role: Role | null;
  orgId: string | null;
  membership: "active" | "pending";
}

export const DEMO_ACTORS: Record<string, Principal> = {
  "employee-demo": { kind: "demo", userId: "employee-demo", displayName: "Demo Employee", role: "employee", orgId: "org_demo", membership: "active" },
  "executive-demo": { kind: "demo", userId: "executive-demo", displayName: "Demo Executive", role: "executive", orgId: "org_demo", membership: "active" },
};

// ---------- Bootstrap allowlist ----------

const Bootstrap = z.object({
  companies: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{2,40}$/), name: z.string().min(1).max(120) })).default([]),
  members: z
    .array(
      z.object({
        email: z.string().email().transform((e) => e.toLowerCase()),
        role: z.enum(["employee", "executive"]),
        company: z.string().regex(/^[a-z0-9_]{2,40}$/),
      }),
    )
    .default([]),
});
type Bootstrap = z.infer<typeof Bootstrap>;

let cache: { path: string; mtimeMs: number; data: Bootstrap } | null = null;

/** Load the allowlist (re-read when the file changes). A missing file means nobody has access. */
export function loadBootstrap(path: string): Bootstrap {
  const p = resolve(path);
  if (!existsSync(p)) return { companies: [], members: [] };
  const mtimeMs = statSync(p).mtimeMs;
  if (cache && cache.path === p && cache.mtimeMs === mtimeMs) return cache.data;
  const data = Bootstrap.parse(JSON.parse(readFileSync(p, "utf8")));
  const seen = new Set<string>();
  for (const m of data.members) {
    if (seen.has(m.email)) throw new Error(`Access bootstrap lists ${m.email} more than once`);
    seen.add(m.email);
  }
  cache = { path: p, mtimeMs, data };
  return data;
}

// ---------- Users ----------

type UserRow = {
  id: string; provider: string; provider_user_id: string; display_name: string; primary_email: string | null; primary_email_verified: number;
  verified_emails: string; avatar_style: string; profile_synced_at: string; last_seen_at: string; created_at: string; updated_at: string;
};

const PROFILE_TTL_MS = 10 * 60_000;

export function getUser(ctx: AppContext, id: string): UserRow | null {
  return (ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

/** Idempotent upsert of the provider identity. Never touches role or membership. */
async function upsertUser(ctx: AppContext, providerUserId: string): Promise<UserRow> {
  const provider = ctx.identity!.kind === "test" ? "test" : "clerk";
  const existing = ctx.db.prepare("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?").get(provider, providerUserId) as UserRow | undefined;
  const now = nowIso();
  if (existing && ctx.now().getTime() - Date.parse(existing.profile_synced_at) < PROFILE_TTL_MS) {
    if (ctx.now().getTime() - Date.parse(existing.last_seen_at) > 60_000) ctx.db.prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now, existing.id);
    return existing;
  }
  const profile: ProviderProfile = await ctx.identity!.getProfile(providerUserId);
  if (existing) {
    // The provider's display name only seeds a new profile; a name the user edited in Runway is kept.
    ctx.db
      .prepare("UPDATE users SET primary_email = ?, primary_email_verified = ?, verified_emails = ?, profile_synced_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
      .run(profile.primaryEmail, profile.primaryEmailVerified ? 1 : 0, JSON.stringify(profile.verifiedEmails), now, now, now, existing.id);
    return getUser(ctx, existing.id)!;
  }
  const id = `usr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  ctx.db
    .prepare(
      "INSERT INTO users (id, provider, provider_user_id, display_name, primary_email, primary_email_verified, verified_emails, profile_synced_at, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_user_id) DO NOTHING",
    )
    .run(id, provider, providerUserId, profile.displayName, profile.primaryEmail, profile.primaryEmailVerified ? 1 : 0, JSON.stringify(profile.verifiedEmails), now, now, now, now);
  return ctx.db.prepare("SELECT * FROM users WHERE provider = ? AND provider_user_id = ?").get(provider, providerUserId) as UserRow;
}

type MembershipRow = { user_id: string; org_id: string; role: Role; status: string; source: string; matched_email: string; created_at: string; updated_at: string };

/**
 * Apply the allowlist to one user: grant, update or revoke the bootstrap membership by matching
 * only provider-verified emails. Memberships are bound to the internal user id (provider id).
 */
export function syncMembership(ctx: AppContext, user: UserRow): MembershipRow | null {
  const boot = loadBootstrap(ctx.config.auth.bootstrapFile);
  const verified: string[] = json(user.verified_emails);
  const entry = boot.members.find((m) => verified.includes(m.email)) ?? null;
  const now = nowIso();
  return tx(ctx.db, () => {
    const current = ctx.db.prepare("SELECT * FROM memberships WHERE user_id = ? AND status = 'active'").get(user.id) as MembershipRow | undefined;
    if (!entry) {
      if (current && current.source === "bootstrap") ctx.db.prepare("UPDATE memberships SET status = 'revoked', updated_at = ? WHERE user_id = ? AND org_id = ?").run(now, user.id, current.org_id);
      return null;
    }
    const companyName = boot.companies.find((c) => c.id === entry.company)?.name;
    const org = ctx.db.prepare("SELECT id FROM organizations WHERE id = ?").get(entry.company);
    if (!org) {
      if (!companyName) throw new AppError("INTERNAL_ERROR", `Access bootstrap references unknown company ${entry.company}`, 500);
      ctx.db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run(entry.company, companyName, now);
    }
    if (current && current.org_id === entry.company && current.role === entry.role) return current;
    if (current) ctx.db.prepare("UPDATE memberships SET status = 'revoked', updated_at = ? WHERE user_id = ? AND org_id = ?").run(now, user.id, current.org_id);
    ctx.db
      .prepare(
        `INSERT INTO memberships (user_id, org_id, role, status, source, matched_email, created_at, updated_at) VALUES (?, ?, ?, 'active', 'bootstrap', ?, ?, ?)
         ON CONFLICT(user_id, org_id) DO UPDATE SET role = excluded.role, status = 'active', source = 'bootstrap', matched_email = excluded.matched_email, updated_at = excluded.updated_at`,
      )
      .run(user.id, entry.company, entry.role, entry.email, now, now);
    return ctx.db.prepare("SELECT * FROM memberships WHERE user_id = ? AND status = 'active'").get(user.id) as MembershipRow;
  });
}

// ---------- Request principal ----------

export interface IncomingAuth {
  authorization?: string;
  demoActorHeader?: string;
  bodyActor?: unknown;
}

/**
 * Resolve the caller. Demo mode (fixtures only) uses the declared demo actor. Clerk mode requires
 * a verified bearer session token and rejects any client-supplied identity field.
 */
export async function resolvePrincipal(ctx: AppContext, a: IncomingAuth): Promise<Principal> {
  if (ctx.config.auth.mode === "demo") {
    const declared = typeof a.bodyActor === "string" ? a.bodyActor : a.demoActorHeader;
    return DEMO_ACTORS[declared ?? "employee-demo"] ?? DEMO_ACTORS["employee-demo"]!;
  }
  if (a.bodyActor !== undefined || a.demoActorHeader !== undefined) {
    throw new AppError("IDENTITY_FIELD_NOT_ALLOWED", "Identity is taken from the signed-in session; remove the actor field/header", 400);
  }
  if (!ctx.identity) throw new AppError("AUTH_NOT_CONFIGURED", "Sign-in is not configured on this server", 503);
  const m = /^Bearer\s+(\S+)$/i.exec(a.authorization ?? "");
  if (!m) throw new AppError("UNAUTHENTICATED", "Sign in to continue", 401);
  let session;
  try {
    session = await ctx.identity.verifySessionToken(m[1]!);
  } catch (e) {
    if (e instanceof AuthError) throw new AppError("UNAUTHENTICATED", e.kind === "expired" ? "Your session expired; sign in again" : "Sign in to continue", 401, false, { reason: e.kind });
    throw e;
  }
  const user = await upsertUser(ctx, session.providerUserId);
  const membership = syncMembership(ctx, user);
  return {
    kind: "user",
    userId: user.id,
    displayName: user.display_name,
    role: membership?.role ?? null,
    orgId: membership?.org_id ?? null,
    membership: membership ? "active" : "pending",
  };
}

// ---------- Authorization helpers ----------

export function requireMember(p: Principal): asserts p is Principal & { role: Role; orgId: string } {
  if (p.membership !== "active" || !p.role || !p.orgId) {
    throw new AppError("ACCESS_PENDING", "Your account is signed in but has not been given access to a company yet", 403);
  }
}

export function requireExecutive(p: Principal): asserts p is Principal & { role: "executive"; orgId: string } {
  requireMember(p);
  if (p.role !== "executive") throw new AppError("FORBIDDEN_ROLE", "This action requires the executive role", 403);
}

/** Display info for an actor id (demo actor or user). */
export function actorInfo(ctx: AppContext, id: string | null): { id: string; displayName: string; role: Role | null; demoIdentity: boolean } | null {
  if (!id) return null;
  const demo = DEMO_ACTORS[id];
  if (demo) return { id, displayName: demo.displayName, role: demo.role, demoIdentity: true };
  const u = getUser(ctx, id);
  if (!u) {
    const legacy = ctx.db.prepare("SELECT label, role FROM actors WHERE id = ?").get(id) as { label: string; role: Role } | undefined;
    return { id, displayName: legacy?.label ?? id, role: legacy?.role ?? null, demoIdentity: !!legacy };
  }
  const m = ctx.db.prepare("SELECT role FROM memberships WHERE user_id = ? AND status = 'active'").get(id) as { role: Role } | undefined;
  return { id, displayName: u.display_name, role: m?.role ?? null, demoIdentity: false };
}

// ---------- Current user ----------

export const AvatarStyle = z.enum(["role_default", "executive_silhouette", "employee_silhouette"]);
export const PatchMeBody = z.object({ displayName: z.string().trim().min(1).max(80).optional(), avatarStyle: AvatarStyle.optional() }).strict();

export function currentUserView(ctx: AppContext, p: Principal) {
  const org = p.orgId ? (ctx.db.prepare("SELECT id, name FROM organizations WHERE id = ?").get(p.orgId) as { id: string; name: string } | undefined) : undefined;
  const u = p.kind === "user" ? getUser(ctx, p.userId) : null;
  return {
    user: {
      id: p.userId,
      displayName: u?.display_name ?? p.displayName,
      email: u?.primary_email ?? null,
      emailVerified: u ? !!u.primary_email_verified : false,
      avatarStyle: (u?.avatar_style ?? "role_default") as z.infer<typeof AvatarStyle>,
      defaultAvatar: p.role === "executive" ? "executive_silhouette" : "employee_silhouette",
    },
    membership: { status: p.membership, role: p.role, company: org ? { id: org.id, name: org.name } : null },
    auth: { mode: ctx.config.auth.mode, demoIdentity: p.kind === "demo" },
  };
}

/** Users may edit only display name and app-local avatar style. Role and company are server-owned. */
export function patchMe(ctx: AppContext, p: Principal, body: unknown) {
  if (p.kind !== "user") throw new AppError("FORBIDDEN_ROLE", "Demo identities have no editable profile", 403);
  const b = PatchMeBody.parse(body);
  const now = nowIso();
  if (b.displayName !== undefined) ctx.db.prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?").run(b.displayName, now, p.userId);
  if (b.avatarStyle !== undefined) ctx.db.prepare("UPDATE users SET avatar_style = ?, updated_at = ? WHERE id = ?").run(b.avatarStyle, now, p.userId);
  return currentUserView(ctx, { ...p, displayName: b.displayName ?? p.displayName });
}
