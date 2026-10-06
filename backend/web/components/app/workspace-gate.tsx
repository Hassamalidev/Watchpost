/*
 * Client gate for /w/[ws]: signed-out users go to /login; the user must be a member of the
 * workspace. Everything below reads the workspace through useWorkspace().
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api, ApiError, wsPath } from "@/lib/api";
import { getSession, listWorkspaces } from "@/lib/auth";
import { WorkspaceContext, type CurrentWorkspace, type WorkspaceRole } from "./workspace-context";

export function WorkspaceGate({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("app");
  const router = useRouter();
  const query = useQuery({
    queryKey: ["workspace-gate", workspaceId],
    staleTime: 60_000,
    queryFn: async (): Promise<CurrentWorkspace | "signed-out" | "no-access"> => {
      const session = await getSession();
      if (session === null) return "signed-out";
      try {
        const me = await api<{ role: WorkspaceRole }>(wsPath(workspaceId, "/me"));
        const workspaces = await listWorkspaces();
        return {
          id: workspaceId,
          name: workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId,
          role: me.role,
          user: { id: session.user.id, email: session.user.email, name: session.user.name },
        };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          return "no-access";
        }
        throw err;
      }
    },
  });

  React.useEffect(() => {
    if (query.data === "signed-out") {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
    }
  }, [query.data, router]);

  if (query.isPending || query.data === "signed-out") {
    return <p className="text-muted-foreground">{t("loading")}</p>;
  }
  if (query.isError || query.data === "no-access") {
    return (
      <div className="flex flex-col gap-2">
        <p>{t("notMember")}</p>
        <Link href="/w" className="text-brand underline">
          {t("pickWorkspace")}
        </Link>
      </div>
    );
  }
  return <WorkspaceContext.Provider value={query.data}>{children}</WorkspaceContext.Provider>;
}
