/*
 * An agency's client workspaces (PRODUCT.md §4 "Built for agencies", Business): each client gets a
 * workspace of its own, run by the agency's owners and admins and paid for by the agency's plan.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { api, errorMessage, wsPath } from "@/lib/api";

interface ClientWorkspace {
  id: string;
  name: string;
  createdAt: string;
}

export function ClientWorkspaces({ ws }: { ws: string }) {
  const t = useTranslations("settings.clients");
  const client = useQueryClient();
  const key = ["client-workspaces", ws] as const;
  const [name, setName] = React.useState("");
  const list = useQuery({
    queryKey: key,
    queryFn: () => api<{ data: ClientWorkspace[] }>(wsPath(ws, "/client-workspaces")),
  });
  const create = useMutation({
    mutationFn: (clientName: string) =>
      api<ClientWorkspace>(wsPath(ws, "/client-workspaces"), {
        method: "POST",
        body: { name: clientName },
      }),
    onSuccess: () => {
      setName("");
      return client.invalidateQueries({ queryKey: key });
    },
  });
  const clients = list.data?.data ?? [];
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-labelledby="clients-heading">
      <h2 id="clients-heading" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {list.isError && <Alert tone="error">{errorMessage(list.error)}</Alert>}
      {list.isSuccess && clients.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
      {clients.length > 0 && (
        <ul className="grid gap-1">
          {clients.map((item) => (
            <li key={item.id} className="flex min-h-9 items-center justify-between gap-3 text-sm">
              <span className="font-medium">{item.name}</span>
              <Link href={`/w/${item.id}`} className="font-medium text-brand underline">
                {t("open", { name: item.name })}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(name.trim());
        }}
      >
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <Field label={t("name")} htmlFor="client-workspace-name" hint={t("nameHint")}>
          <Input
            id="client-workspace-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div>
          <Button type="submit" disabled={create.isPending || name.trim().length < 2}>
            {t("create")}
          </Button>
        </div>
      </form>
    </section>
  );
}
