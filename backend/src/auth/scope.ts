// Company and ownership scoping for every resource reached by id. Resources in another company are
// reported as not found (no existence leak); a wrong role within the company is forbidden.
import type { AppContext } from "../app/context.js";
import { AppError, notFound } from "../lib/errors.js";
import { requireExecutive, requireMember, type Principal } from "./access.js";

type Mode = "read" | "write";

interface Owned {
  orgId: string;
  ownerId: string;
}

function check(p: Principal, owned: Owned | undefined, what: string, id: string, mode: Mode): Owned {
  requireMember(p);
  if (!owned || owned.orgId !== p.orgId) throw notFound(what, id);
  const isOwner = owned.ownerId === p.userId;
  if (mode === "read" && (isOwner || p.role === "executive")) return owned;
  if (mode === "write" && isOwner) return owned;
  // Same company but not permitted: employees cannot see colleagues' private requests.
  if (p.role !== "executive") throw notFound(what, id);
  throw new AppError("FORBIDDEN_ROLE", `Only the employee who owns this ${what.toLowerCase()} can change it`, 403);
}

export function requestAccess(ctx: AppContext, p: Principal, requestId: string, mode: Mode): Owned {
  const r = ctx.db.prepare("SELECT org_id AS orgId, created_by AS ownerId FROM requests WHERE id = ?").get(requestId) as Owned | undefined;
  return check(p, r, "Request", requestId, mode);
}

export function runAccess(ctx: AppContext, p: Principal, runId: string, mode: Mode): Owned {
  const r = ctx.db.prepare("SELECT r.org_id AS orgId, r.created_by AS ownerId FROM runs x JOIN requests r ON r.id = x.request_id WHERE x.id = ?").get(runId) as Owned | undefined;
  return check(p, r, "Run", runId, mode);
}

export function proposalAccess(ctx: AppContext, p: Principal, proposalId: string, mode: Mode): Owned {
  const r = ctx.db.prepare("SELECT r.org_id AS orgId, r.created_by AS ownerId FROM proposals x JOIN requests r ON r.id = x.request_id WHERE x.id = ?").get(proposalId) as Owned | undefined;
  return check(p, r, "Proposal", proposalId, mode);
}

export function executionAccess(ctx: AppContext, p: Principal, executionId: string, mode: "read" | "reconcile"): Owned {
  const r = ctx.db
    .prepare("SELECT r.org_id AS orgId, r.created_by AS ownerId FROM executions e JOIN proposals x ON x.id = e.proposal_id JOIN requests r ON r.id = x.request_id WHERE e.id = ?")
    .get(executionId) as Owned | undefined;
  if (mode === "reconcile") {
    requireExecutive(p);
    if (!r || r.orgId !== p.orgId) throw notFound("Execution", executionId);
    return r;
  }
  return check(p, r, "Execution", executionId, "read");
}

export function projectAccess(ctx: AppContext, p: Principal, projectId: string, mode: Mode): Owned {
  const r = ctx.db.prepare("SELECT org_id AS orgId, created_by AS ownerId FROM projects WHERE id = ?").get(projectId) as Owned | undefined;
  return check(p, r, "Project", projectId, mode);
}

/** The Nessie account, merchant mappings and purchase history belong to one configured company. */
export function accountAccess(ctx: AppContext, p: Principal): void {
  requireExecutive(p);
  if (p.orgId !== ctx.config.auth.accountCompanyId) throw new AppError("FORBIDDEN_ROLE", "This company has no bank account configured on this server", 403);
}
