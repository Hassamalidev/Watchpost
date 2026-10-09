/*
 * Client gate for /w/[ws]: signed-out users go to /login; the user must be a member of the
 * workspace. Everything below reads the workspace through useWorkspace().
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api, ApiError, wsPath } from "@/lib/api";
import { getSession, listWorkspaces } from "@/lib/auth";
import {
  PERSONAL_SEGMENTS,
  activeSegment,
  homeSegment,
  navItemsFor,
  workspaceHref,
} from "@/lib/navigation";
import { Alert } from "@/components/ui/alert";
import { TwoFactorCard } from "@/features/security/components/two-factor-card";
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
  const pathname = usePathname();
  const query = useQuery({
    queryKey: ["workspace-gate", workspaceId],
    staleTime: 60_000,
    queryFn: async (): Promise<CurrentWorkspace | "signed-out" | "no-access" | "two-factor"> => {
      const session = await getSession();
      if (session === null) return "signed-out";
      try {
        const me = await api<{
          role: WorkspaceRole;
          twoFactorRequired?: boolean;
          name?: string;
          parent?: { id: string; name: string } | null;
        }>(wsPath(workspaceId, "/me"));
        if (me.twoFactorRequired === true) return "two-factor";
        /*
         * The name comes with the answer: an agency's admins open client workspaces they aren't
         * listed as members of.
         */
        const name =
          me.name ??
          (await listWorkspaces()).find((w) => w.id === workspaceId)?.name ??
          workspaceId;
        return {
          id: workspaceId,
          name,
          role: me.role,
          parent: me.parent ?? null,
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

  /*
   * A section the role can't open (the billing role anywhere but billing) goes to the role's home
   * instead of a page full of "not allowed" errors.
   */
  const role = typeof query.data === "object" ? query.data.role : undefined;
  const segment = activeSegment(pathname);
  const offLimits =
    role !== undefined &&
    segment !== undefined &&
    !PERSONAL_SEGMENTS.includes(segment) &&
    !navItemsFor(role).some((item) => item.segment === segment);
  React.useEffect(() => {
    if (offLimits && role !== undefined) {
      router.replace(workspaceHref(workspaceId, homeSegment(role)));
    }
  }, [offLimits, role, router, workspaceId]);

  if (query.isPending || query.data === "signed-out" || offLimits) {
    return <p className="text-muted-foreground">{t("loading")}</p>;
  }
  /* The workspace requires two-factor sign-in and this person hasn't set it up: that comes first. */
  if (query.data === "two-factor") {
    return (
      <div className="mx-auto grid max-w-2xl gap-4 p-4">
        <Alert tone="info">{t("twoFactorRequired")}</Alert>
        <TwoFactorCard enabled={false} onChanged={() => void query.refetch()} />
      </div>
    );
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
