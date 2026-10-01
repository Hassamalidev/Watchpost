/*
 * Deploy markers setup (P1-T26): one URL per workspace. CI posts to it, or GitHub sends deployment
 * webhooks to it, so incidents can say "started 2 minutes after deploy abc123". The URL and the GitHub
 * secret are shown once; rotating retires the old URL.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Copy, Rocket } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, errorMessage, wsPath } from "@/lib/api";

interface NewHook {
  url: string;
  githubUrl: string;
  githubSecret: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const tc = useTranslations("common");
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-2">
        <Input readOnly value={value} aria-label={label} className="font-mono text-xs" />
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          }}
        >
          <Copy aria-hidden />
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </div>
    </div>
  );
}

export function DeployHookCard({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("insights");
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["deploy-hook", ws],
    queryFn: () =>
      api<{ configured: boolean; createdAt: string | null }>(wsPath(ws, "/deploy-hook")),
  });
  const rotate = useMutation({
    mutationFn: () => api<NewHook>(wsPath(ws, "/deploy-hook"), { method: "POST", body: {} }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["deploy-hook", ws] }),
  });
  const configured = status.data?.configured ?? false;
  const hook = rotate.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket aria-hidden className="size-4" />
          {t("deployTitle")}
        </CardTitle>
        <CardDescription>{t("deployIntro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        {rotate.isError && <Alert tone="error">{errorMessage(rotate.error)}</Alert>}
        {hook ? (
          <>
            <Alert tone="info">{t("deployOnce")}</Alert>
            <CopyField label={t("deployUrl")} value={hook.url} />
            <CopyField
              label={t("deployCurl")}
              value={`curl -X POST ${hook.url} -H 'content-type: application/json' -d '{"version":"'$GIT_SHA'","environment":"production"}'`}
            />
            <div className="grid gap-2 rounded-md border p-3">
              <p className="font-medium">{t("deployGithubTitle")}</p>
              <p className="text-muted-foreground">{t("deployGithubSteps")}</p>
              <CopyField label={t("deployGithubUrl")} value={hook.githubUrl} />
              <CopyField label={t("deployGithubSecret")} value={hook.githubSecret} />
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">
            {configured ? t("deployConfigured") : t("deployNotConfigured")}
          </p>
        )}
        {canManage && !hook && (
          <div>
            <Button
              variant="outline"
              disabled={rotate.isPending || status.isPending}
              onClick={() => {
                if (configured && !window.confirm(t("deployRotateConfirm"))) return;
                rotate.mutate();
              }}
            >
              {configured ? t("deployRotate") : t("deployCreate")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
