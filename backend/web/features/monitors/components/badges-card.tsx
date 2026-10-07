/*
 * Badges for a monitor: small images of its status, uptime and response time to paste into a
 * README or a dashboard. The URL is signed, so only people you give it to can read it.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { errorMessage } from "@/lib/api";
import { monitorsApi } from "../api";

export const BADGE_KINDS = ["status", "uptime", "latency"] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

/* What to paste into a Markdown file: the image, linking back to us. */
export function badgeMarkdown(alt: string, imageUrl: string, link: string): string {
  return `[![${alt.replace(/[[\]]/g, "")}](${imageUrl})](${link})`;
}

export function BadgesCard({
  ws,
  monitorId,
  name,
}: {
  ws: string;
  monitorId: string;
  name: string;
}) {
  const t = useTranslations("monitors.badges");
  const [kind, setKind] = React.useState<BadgeKind>("status");
  const links = useQuery({
    queryKey: ["monitors", ws, monitorId, "badges"],
    queryFn: () => monitorsApi.badges(ws, monitorId),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {links.isLoading ? (
          <Loading rows={2} />
        ) : links.isError || links.data === undefined ? (
          <Alert tone="error">{errorMessage(links.error)}</Alert>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-4">
              <Field label={t("kind")} htmlFor="badge-kind">
                <Select
                  id="badge-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as BadgeKind)}
                >
                  {BADGE_KINDS.map((value) => (
                    <option key={value} value={value}>
                      {t(`kinds.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {/* Same origin here, so the preview loads whatever host the app runs on. */}
              {/* A plain img: the badge is an SVG the API draws. */}
              <img
                src={new URL(links.data[kind]).pathname}
                alt={t("previewAlt", { kind: t(`kinds.${kind}`), name })}
                height={20}
                className="h-5"
              />
            </div>
            <CopyField
              label={t("markdown")}
              value={badgeMarkdown(
                `${name} ${t(`kinds.${kind}`).toLowerCase()}`,
                links.data[kind],
                links.data.link,
              )}
            />
            <CopyField label={t("imageUrl")} value={links.data[kind]} />
            <p className="text-xs text-muted-foreground">{t("hint")}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
