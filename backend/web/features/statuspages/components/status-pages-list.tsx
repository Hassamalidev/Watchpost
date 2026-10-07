/*
 * Status pages of the workspace, and the form that starts a new one from the monitors you pick
 * (one component per monitor; everything else is edited on the page's own screen).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { statusSlugSchema } from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert, EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { ApiError, errorMessage } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";
import { useMonitors } from "@/features/monitors/hooks";
import { slugFromName, statusPageKeys, statusPagesApi, useStatusPages } from "../api";

function NewPage({ ws }: { ws: string }) {
  const t = useTranslations("statusPages");
  const tc = useTranslations("common");
  const router = useRouter();
  const client = useQueryClient();
  const monitors = useMonitors(ws);
  const [name, setName] = React.useState("");
  const [slug, setSlug] = React.useState("");
  const [slugEdited, setSlugEdited] = React.useState(false);
  /* Every monitor is on the page until the user unticks some. */
  const [left, setLeft] = React.useState<string[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      statusPagesApi.create(ws, {
        name: name.trim(),
        slug,
        monitorIds: (monitors.data ?? []).map((m) => m.id).filter((id) => !left.includes(id)),
      }),
    onSuccess: async (page) => {
      await client.invalidateQueries({ queryKey: statusPageKeys.all(ws) });
      router.push(workspaceHref(ws, `status-pages/${page.id}`));
    },
    onError: (err) => {
      const first = err instanceof ApiError ? err.fieldErrors[0] : undefined;
      setProblem(first ? first.message : errorMessage(err));
    },
  });

  function submit() {
    setProblem(null);
    if (name.trim() === "") {
      setProblem(t("nameRequired"));
      return;
    }
    const parsed = statusSlugSchema.safeParse(slug);
    if (!parsed.success) {
      setProblem(t("addressInvalid"));
      return;
    }
    create.mutate();
  }

  return (
    <form
      className="grid max-w-xl gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {problem && <Alert tone="error">{problem}</Alert>}
      <Field label={t("name")} htmlFor="sp-name" hint={t("nameHint")}>
        <Input
          id="sp-name"
          value={name}
          maxLength={120}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugEdited) setSlug(slugFromName(e.target.value));
          }}
        />
      </Field>
      <Field label={t("address")} htmlFor="sp-slug" hint={t("addressHint")}>
        <Input
          id="sp-slug"
          value={slug}
          maxLength={63}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => {
            setSlugEdited(true);
            setSlug(e.target.value.toLowerCase());
          }}
        />
      </Field>
      {(monitors.data ?? []).length > 0 && (
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("monitorsOnPage")}</legend>
          <p className="text-xs text-muted-foreground">{t("monitorsOnPageHint")}</p>
          <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
            {(monitors.data ?? []).map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!left.includes(m.id)}
                  onChange={(e) =>
                    setLeft((current) =>
                      e.target.checked ? current.filter((id) => id !== m.id) : [...current, m.id],
                    )
                  }
                />
                {m.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? tc("saving") : t("create")}
        </Button>
      </div>
    </form>
  );
}

export function StatusPagesList() {
  const t = useTranslations("statusPages");
  const { id: ws, role } = useWorkspace();
  const pages = useStatusPages(ws);
  const canEdit = can(role, "statusPage:write");

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </div>
      {pages.isLoading ? (
        <Loading />
      ) : pages.isError ? (
        <Alert tone="error">{errorMessage(pages.error)}</Alert>
      ) : (pages.data ?? []).length === 0 ? (
        <EmptyState title={t("emptyTitle")}>{t("emptyBody")}</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {(pages.data ?? []).map((page) => (
            <li key={page.id}>
              <Card>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <Link
                      href={workspaceHref(ws, `status-pages/${page.id}`)}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {page.name}
                    </Link>
                    <p className="truncate text-sm text-muted-foreground">
                      {page.published ? page.url : t("unpublished")} ·{" "}
                      {t("componentCount", { count: page.components.length })}
                    </p>
                  </div>
                  {page.published && (
                    <a
                      href={page.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm underline underline-offset-4"
                    >
                      {t("view")}
                    </a>
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>{t("newTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <NewPage ws={ws} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
