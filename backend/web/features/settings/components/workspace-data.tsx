/*
 * The workspace's data (PRODUCT.md §13 "Privacy"): download everything as one JSON file, and
 * delete the workspace. Deletion waits 30 days, in which an owner can cancel it.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  WORKSPACE_DELETION_DAYS,
  type WorkspaceDeletionView,
  type WorkspaceExport,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

/* Hands a JSON document to the browser as a file. */
function saveAsFile(data: WorkspaceExport, name: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function WorkspaceData({
  ws,
  name,
  isOwner,
}: {
  ws: string;
  name: string;
  isOwner: boolean;
}) {
  const t = useTranslations("settings.data");
  const client = useQueryClient();
  const key = ["workspace-deletion", ws] as const;
  const [confirm, setConfirm] = React.useState("");
  const download = useMutation({
    mutationFn: () => api<WorkspaceExport>(wsPath(ws, "/privacy/export")),
    onSuccess: (data) => saveAsFile(data, `workspace-${data.exportedAt.slice(0, 10)}.json`),
  });
  const deletion = useQuery({
    queryKey: key,
    queryFn: () => api<WorkspaceDeletionView>(wsPath(ws, "/privacy/deletion")),
  });
  const done = (view: WorkspaceDeletionView) => {
    setConfirm("");
    client.setQueryData(key, view);
    /* Monitors were paused: lists that show them are stale. */
    void client.invalidateQueries({ queryKey: ["monitors", ws] });
  };
  const ask = useMutation({
    mutationFn: () =>
      api<WorkspaceDeletionView>(wsPath(ws, "/privacy/deletion"), {
        method: "POST",
        body: { confirm },
      }),
    onSuccess: done,
  });
  const cancel = useMutation({
    mutationFn: () =>
      api<WorkspaceDeletionView>(wsPath(ws, "/privacy/deletion"), { method: "DELETE" }),
    onSuccess: done,
  });
  const scheduled = deletion.data?.scheduled === true;
  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="data-heading">
      <h2 id="data-heading" className="text-base font-semibold">
        {t("title")}
      </h2>
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">{t("exportIntro")}</p>
        {download.isError && <Alert tone="error">{errorMessage(download.error)}</Alert>}
        <div>
          <Button variant="outline" disabled={download.isPending} onClick={() => download.mutate()}>
            {download.isPending ? t("exporting") : t("export")}
          </Button>
        </div>
      </div>
      <div className="grid gap-2 border-t pt-4">
        <h3 className="text-sm font-semibold">{t("deleteTitle")}</h3>
        {deletion.isError && <Alert tone="error">{errorMessage(deletion.error)}</Alert>}
        {scheduled ? (
          <>
            <Alert tone="error">
              {t("scheduled", {
                when: formatDateTime(deletion.data?.deleteAfter),
                by: deletion.data?.requestedBy ?? "",
              })}
            </Alert>
            {cancel.isError && <Alert tone="error">{errorMessage(cancel.error)}</Alert>}
            {isOwner ? (
              <div>
                <Button
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  {t("cancel")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("ownerCancels")}</p>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("deleteIntro", { days: WORKSPACE_DELETION_DAYS })}
            </p>
            {!isOwner && <p className="text-sm text-muted-foreground">{t("ownerOnly")}</p>}
            {isOwner && deletion.isSuccess && (
              <form
                className="grid gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  ask.mutate();
                }}
              >
                {ask.isError && <Alert tone="error">{errorMessage(ask.error)}</Alert>}
                <Field
                  label={t("confirm")}
                  htmlFor="delete-workspace-confirm"
                  hint={t("confirmHint", { name })}
                >
                  <Input
                    id="delete-workspace-confirm"
                    value={confirm}
                    autoComplete="off"
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
                <div>
                  <Button
                    type="submit"
                    variant="outline"
                    className="border-status-down text-status-down"
                    disabled={ask.isPending || confirm.trim() !== name.trim()}
                  >
                    {t("delete")}
                  </Button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}
