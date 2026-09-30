/*
 * WorkspaceScope: the tenancy token every service method that touches tenant data takes first
 * (PRODUCT.md §7.1 rule 8). It is branded, so a raw string or a hand-made object cannot be passed
 * where a scope is expected; only the workspace middleware (or tests) create one.
 */
declare const scopeBrand: unique symbol;

export type WorkspaceRole = "owner" | "admin" | "member" | "responder" | "viewer" | "billing";

export interface WorkspaceScope {
  readonly workspaceId: string;
  /* The acting user, or undefined for system work (jobs, sweeps). */
  readonly actorUserId: string | undefined;
  readonly role: WorkspaceRole | "system";
  readonly [scopeBrand]: true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MissingScopeError extends Error {
  constructor(message = "A WorkspaceScope is required for tenant data") {
    super(message);
    this.name = "MissingScopeError";
  }
}

export function createWorkspaceScope(input: {
  workspaceId: string;
  actorUserId?: string;
  role?: WorkspaceRole;
}): WorkspaceScope {
  if (!UUID.test(input.workspaceId))
    throw new MissingScopeError(`Invalid workspace ID "${input.workspaceId}"`);
  return Object.freeze({
    workspaceId: input.workspaceId.toLowerCase(),
    actorUserId: input.actorUserId,
    role: input.role ?? "system",
  }) as WorkspaceScope;
}

/* Runtime guard for code paths that receive `unknown` (job data, JS callers). */
export function assertWorkspaceScope(scope: unknown): asserts scope is WorkspaceScope {
  const candidate = scope as Partial<WorkspaceScope> | null | undefined;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof candidate.workspaceId !== "string" ||
    !UUID.test(candidate.workspaceId) ||
    !Object.isFrozen(candidate)
  ) {
    throw new MissingScopeError();
  }
}
