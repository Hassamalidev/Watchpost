/* Workspace layout. Auth and workspace membership checks arrive in P1-T01. */
import type * as React from "react";
import { AppShell } from "@/components/app/app-shell";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  return <AppShell workspace={decodeURIComponent(ws)}>{children}</AppShell>;
}
