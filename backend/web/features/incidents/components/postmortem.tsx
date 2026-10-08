/*
 * The incident's postmortem (PRODUCT.md §6.9): Markdown a person writes or starts from an AI draft,
 * edits, saves and exports. The draft is built from the incident's own record; its facts and
 * timeline are ours, the wording around them is the model's and is marked as such.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import type { PostmortemView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { incidentsApi } from "../api";

export function PostmortemCard({
  ws,
  incidentNumber,
  canEdit,
}: {
  ws: string;
  incidentNumber: number;
  canEdit: boolean;
}) {
  const t = useTranslations("incidents.postmortem");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const key = ["postmortem", ws, incidentNumber] as const;
  const stored = useQuery({
    queryKey: key,
    queryFn: async () => (await incidentsApi.postmortem(ws, incidentNumber)).data,
  });
  const [text, setText] = React.useState<string | null>(null);
  const markdown = text ?? stored.data?.markdown ?? "";
  const dirty = text !== null && text !== (stored.data?.markdown ?? "");
  const keep = (saved: PostmortemView) => {
    client.setQueryData(key, saved);
    setText(null);
  };

  const save = useMutation({
    mutationFn: () => incidentsApi.savePostmortem(ws, incidentNumber, markdown),
    onSuccess: keep,
  });
  const draft = useMutation({
    mutationFn: () => incidentsApi.draftPostmortem(ws, incidentNumber),
    onSuccess: keep,
  });
  const base = wsPath(ws, `/incidents/${incidentNumber}/postmortem`);
  const hasOne = stored.data != null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {stored.isLoading ? (
          <Loading rows={2} />
        ) : (
          <>
            {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
            {draft.isError && <Alert tone="info">{errorMessage(draft.error)}</Alert>}
            {!hasOne && !canEdit && <p className="text-sm text-muted-foreground">{t("none")}</p>}
            {(hasOne || canEdit) && (
              <>
                <label htmlFor="postmortem-text" className="text-sm font-medium">
                  {t("label")}
                </label>
                <Textarea
                  id="postmortem-text"
                  rows={hasOne || text !== null ? 18 : 5}
                  className="font-mono text-xs"
                  readOnly={!canEdit}
                  value={markdown}
                  placeholder={t("placeholder")}
                  onChange={(e) => setText(e.target.value)}
                />
              </>
            )}
            {stored.data && (
              <p className="text-xs text-muted-foreground">
                {stored.data.aiDrafted ? t("startedByAi") : t("writtenByHand")}{" "}
                {t("savedAt", { time: formatDateTime(stored.data.updatedAt) })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canEdit && (
                <Button
                  disabled={save.isPending || !dirty || markdown.trim() === ""}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? tc("saving") : tc("save")}
                </Button>
              )}
              {canEdit && (
                <Button
                  variant="outline"
                  disabled={draft.isPending}
                  onClick={() => {
                    if (!hasOne || globalThis.confirm(t("confirmRedraft"))) draft.mutate();
                  }}
                >
                  <Sparkles aria-hidden />
                  {draft.isPending ? t("drafting") : t("draft")}
                </Button>
              )}
              {hasOne && (
                <>
                  <a className="text-sm underline underline-offset-4" href={`${base}.md`}>
                    {t("downloadMarkdown")}
                  </a>
                  <a className="text-sm underline underline-offset-4" href={`${base}.pdf`}>
                    {t("downloadPdf")}
                  </a>
                </>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
