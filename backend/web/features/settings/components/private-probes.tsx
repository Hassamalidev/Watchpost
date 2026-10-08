/*
 * Private probes in Settings (PRODUCT.md §4): probes the customer runs inside their own network.
 * Adding one shows its install command once; the list shows whether each is online, what it runs
 * and whether a newer probe program is out.
 */
"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleX } from "lucide-react";
import type { CreatedPrivateProbe } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { privateProbesApi, privateProbesKey, usePrivateProbes } from "../private-probes";

export function PrivateProbes({ ws, canManage }: { ws: string; canManage: boolean }) {
  const t = useTranslations("settings.privateProbes");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const probes = usePrivateProbes(ws);
  const [name, setName] = React.useState("");
  /* The probe just added: its command is shown until the page is left, and never again. */
  const [made, setMade] = React.useState<CreatedPrivateProbe | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: privateProbesKey(ws) });
  const create = useMutation({
    mutationFn: (probeName: string) => privateProbesApi.create(ws, probeName),
    onSuccess: async (probe) => {
      setMade(probe);
      setName("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => privateProbesApi.remove(ws, id),
    onSuccess: refresh,
  });
  const list = probes.data ?? [];

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="private-probes-heading">
      <div className="grid gap-1">
        <h2 id="private-probes-heading" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {made && (
        <Alert tone="info">
          <div className="grid gap-2">
            <p className="font-medium">{t("madeTitle", { name: made.name })}</p>
            <CopyField label={t("commandLabel")} value={made.command} />
            <p className="text-sm">{t("commandHint")}</p>
          </div>
        </Alert>
      )}
      {probes.isLoading ? (
        <Loading rows={2} />
      ) : probes.isError ? (
        <Alert tone="error">{errorMessage(probes.error)}</Alert>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="grid gap-2">
          {list.map((probe) => {
            const Icon = probe.online ? CircleCheck : CircleX;
            return (
              <li
                key={probe.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    <Icon
                      aria-hidden
                      className={`size-4 ${probe.online ? "text-status-up" : "text-status-down"}`}
                    />
                    {probe.name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {probe.lastSeenAt === null
                      ? t("neverSeen")
                      : probe.online
                        ? t("online")
                        : t("offline", { when: relativeTime(probe.lastSeenAt) })}{" "}
                    · {t("monitorCount", { count: probe.monitors })}
                    {probe.version === null ? "" : ` · ${t("version", { version: probe.version })}`}
                  </p>
                  {probe.upgradeAvailable && <p className="text-sm">{t("upgrade")}</p>}
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={remove.isPending}
                    aria-label={t("removeNamed", { name: probe.name })}
                    onClick={() => {
                      if (globalThis.confirm(t("confirmRemove", { name: probe.name }))) {
                        remove.mutate(probe.id);
                      }
                    }}
                  >
                    {t("remove")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
      {canManage && (
        <form
          className="grid max-w-xl gap-4 border-t pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== "") create.mutate(name.trim());
          }}
        >
          {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
          <Field label={t("name")} htmlFor="private-probe-name" hint={t("nameHint")}>
            <Input
              id="private-probe-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={create.isPending || name.trim() === ""}>
              {create.isPending ? tc("saving") : t("add")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
