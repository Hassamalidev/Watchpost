/*
 * Accepting a workspace invitation from the email link. Signed-out visitors sign in or create an
 * account first and come back here; the invitation only opens for the address it was sent to.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { UsersRound } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { acceptInvitation, getInvitation, getSession, rejectInvitation } from "@/lib/auth";

export function Invitation({ id }: { id: string }) {
  const t = useTranslations("invite");
  const router = useRouter();
  const next = `/invite/${encodeURIComponent(id)}`;
  const session = useQuery({ queryKey: ["session"], queryFn: getSession, retry: false });
  const signedIn = Boolean(session.data?.user);
  const invitation = useQuery({
    queryKey: ["invitation", id],
    queryFn: () => getInvitation(id),
    enabled: signedIn,
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => acceptInvitation(id),
    onSuccess: () => {
      if (invitation.data) router.replace(`/w/${invitation.data.organizationId}/overview`);
    },
  });
  const decline = useMutation({ mutationFn: () => rejectInvitation(id) });

  let body: React.ReactNode;
  if (session.isPending || (signedIn && invitation.isPending)) {
    body = <p className="text-muted-foreground">{t("loading")}</p>;
  } else if (!signedIn) {
    body = (
      <div className="grid gap-3">
        <p>{t("signInFirst")}</p>
        <Button asChild className="h-11">
          <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("signIn")}</Link>
        </Button>
        <Button asChild variant="outline" className="h-11">
          <Link href={`/signup?next=${encodeURIComponent(next)}`}>{t("signUp")}</Link>
        </Button>
      </div>
    );
  } else if (invitation.isError) {
    body = (
      <Alert tone="error">
        {t("unavailable", { email: session.data?.user.email ?? "" })}{" "}
        {errorMessage(invitation.error)}
      </Alert>
    );
  } else if (decline.isSuccess) {
    body = <Alert tone="info">{t("declined")}</Alert>;
  } else if (invitation.data) {
    const { organizationName, inviterEmail, role, status } = invitation.data;
    body = (
      <div className="grid gap-4">
        <p>
          {t.rich("summary", {
            inviter: inviterEmail,
            workspace: organizationName,
            role,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
        {(accept.isError || decline.isError) && (
          <Alert tone="error">{errorMessage(accept.error ?? decline.error)}</Alert>
        )}
        {status === "pending" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              className="h-11"
              disabled={accept.isPending || decline.isPending}
              onClick={() => accept.mutate()}
            >
              {accept.isPending ? t("joining") : t("accept", { workspace: organizationName })}
            </Button>
            <Button
              variant="outline"
              className="h-11"
              disabled={accept.isPending || decline.isPending}
              onClick={() => decline.mutate()}
            >
              {t("decline")}
            </Button>
          </div>
        ) : (
          <Alert tone="info">{t("notPending")}</Alert>
        )}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <UsersRound aria-hidden className="size-6 text-brand" />
        <h1 className="text-xl font-semibold">{t("title")}</h1>
      </CardHeader>
      <CardContent className="grid gap-4">{body}</CardContent>
    </Card>
  );
}
