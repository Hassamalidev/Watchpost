/* Team: members with their roles, and invitations in any role but owner (admins). */
"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { can, useWorkspace, type WorkspaceRole } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { inviteMember, type InvitableRole } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";

/* From the most access to the least; billing sees billing pages only. */
const INVITABLE_ROLES: readonly InvitableRole[] = [
  "admin",
  "member",
  "responder",
  "viewer",
  "billing",
];

interface Member {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: string;
}

export function TeamPage() {
  const t = useTranslations("team");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const members = useQuery({
    queryKey: ["members", ws],
    queryFn: async () => (await api<{ data: Member[] }>(wsPath(ws, "/members"))).data,
    /* The member list is for admins (§6.11). */
    enabled: can(workspace.role, "roster:read"),
  });
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<InvitableRole>("member");
  const invite = useMutation({ mutationFn: () => inviteMember(ws, email.trim(), role) });

  return (
    <div className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <section className="grid gap-2" aria-labelledby="members-heading">
        <h2 id="members-heading" className="text-base font-semibold">
          {t("members")}
        </h2>
        {!can(workspace.role, "roster:read") ? null : members.isPending ? (
          <Loading rows={2} />
        ) : (
          <ul className="divide-y rounded-lg border">
            {(members.data ?? []).map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs text-muted-foreground">{m.email}</p>
                </div>
                <span className="text-sm">{t(`roles.${m.role}`)}</span>
                <span className="text-xs text-muted-foreground">{formatDateTime(m.joinedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {can(workspace.role, "roster:read") && (
        <Card>
          <CardHeader>
            <CardTitle>{t("invite")}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid max-w-md gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              {invite.isError && <Alert tone="error">{errorMessage(invite.error)}</Alert>}
              {invite.isSuccess && <Alert tone="success">{t("invited", { email })}</Alert>}
              <Field label={t("inviteEmail")} htmlFor="invite-email">
                <Input
                  id="invite-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field label={t("role")} htmlFor="invite-role" hint={t(`roleHints.${role}`)}>
                <Select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as InvitableRole)}
                >
                  {INVITABLE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <Button type="submit" disabled={invite.isPending}>
                  {t("send")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
