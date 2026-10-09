/*
 * Privacy tooling (PRODUCT.md §13 "Privacy"): a workspace's data as one JSON file, and deleting the
 * workspace after 30 days in which the owner can change their mind.
 */
import { z } from "zod";

/* How long a workspace waits between "delete" and being erased. */
export const WORKSPACE_DELETION_DAYS = 30;
export const WORKSPACE_EXPORT_VERSION = 1;
/* The newest incidents an export carries; older ones are counted in `notes`. */
export const WORKSPACE_EXPORT_MAX_INCIDENTS = 5000;

/* The owner types the workspace's name to confirm. */
export const requestWorkspaceDeletionSchema = z
  .object({ confirm: z.string().trim().min(1).max(200) })
  .strict();

export interface WorkspaceDeletionView {
  scheduled: boolean;
  requestedAt: string | null;
  /* Who asked for it (their email address at the time). */
  requestedBy: string | null;
  /* From when the workspace is erased; until then deletion can be cancelled. */
  deleteAfter: string | null;
}

/* Everything the team put into a workspace. Secrets are never included: they are masked. */
export interface WorkspaceExport {
  version: typeof WORKSPACE_EXPORT_VERSION;
  exportedAt: string;
  workspace: { id: string; name: string; settings: unknown };
  members: unknown[];
  monitors: unknown[];
  incidents: unknown[];
  maintenance: unknown[];
  channels: unknown[];
  contactMethods: unknown[];
  onCall: { schedules: unknown[]; escalationPolicies: unknown[] };
  statusPages: Array<{ page: unknown; incidents: unknown[]; subscribers: unknown }>;
  /* What is not in the file, and where to get it. */
  notes: string[];
}
