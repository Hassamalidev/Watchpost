/* The regions monitors are checked from, and whether each is working right now. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CircleCheck, CircleX } from "lucide-react";
import { monitorsApi } from "@/features/monitors/api";

export function CheckRegions({ ws }: { ws: string }) {
  const t = useTranslations("settings.regions");
  const regions = useQuery({
    queryKey: ["check-regions", ws],
    queryFn: async () => (await monitorsApi.checkRegions(ws)).data,
    refetchInterval: 30_000,
  });
  if (regions.data === undefined) return null;

  return (
    <section className="grid gap-2 rounded-lg border p-4" aria-labelledby="regions-heading">
      <h2 id="regions-heading" className="text-base font-semibold">
        {t("title")}
      </h2>
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {regions.data.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-1 text-sm">
          {regions.data.map(({ region, healthy }) => {
            const Icon = healthy ? CircleCheck : CircleX;
            return (
              <li key={region} className="flex items-center gap-2">
                <Icon
                  aria-hidden
                  className={`size-4 ${healthy ? "text-status-up" : "text-status-down"}`}
                />
                <span className="font-mono">{region}</span>
                <span className="text-muted-foreground">
                  {healthy ? t("healthy") : t("unhealthy")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
