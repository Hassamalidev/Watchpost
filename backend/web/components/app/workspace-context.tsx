/*
 * The current workspace for client components, loaded once by the workspace gate: the ID from the
 * URL, its name, and the signed-in user's role (the UI hides what the role can't do; the API
 * enforces it).
 */
"use client";

import * as React from "react";
import { roleCan, type Permission, type WorkspaceRole } from "@app/shared";

export type { Permission, WorkspaceRole } from "@app/shared";

export interface CurrentWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
  user: { id: string; email: string; name: string };
}

export const WorkspaceContext = React.createContext<CurrentWorkspace | null>(null);

export function useWorkspace(): CurrentWorkspace {
  const workspace = React.useContext(WorkspaceContext);
  if (workspace === null) throw new Error("useWorkspace outside the workspace gate");
  return workspace;
}

/* The same role table the API enforces (PRODUCT.md §6.11). */
export function can(role: WorkspaceRole, permission: Permission): boolean {
  return roleCan(role, permission);
}
