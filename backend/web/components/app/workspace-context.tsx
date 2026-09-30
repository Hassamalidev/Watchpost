/*
 * The current workspace for client components, loaded once by the workspace gate: the ID from the
 * URL, its name, and the signed-in user's role (the UI hides what the role can't do; the API
 * enforces it).
 */
"use client";

import * as React from "react";

export type WorkspaceRole = "owner" | "admin" | "member" | "responder" | "viewer" | "billing";

export interface CurrentWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  user: { id: string; email: string; name: string };
}

const RANK: Record<WorkspaceRole, number> = {
  billing: 0,
  viewer: 1,
  responder: 2,
  member: 3,
  admin: 4,
  owner: 5,
};

export const WorkspaceContext = React.createContext<CurrentWorkspace | null>(null);

export function useWorkspace(): CurrentWorkspace {
  const workspace = React.useContext(WorkspaceContext);
  if (workspace === null) throw new Error("useWorkspace outside the workspace gate");
  return workspace;
}

export function can(role: WorkspaceRole, minimum: WorkspaceRole): boolean {
  return RANK[role] >= RANK[minimum];
}
