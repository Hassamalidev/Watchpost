/* My on-call: whether you are on call right now, until when, and when your next shifts are. */
"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { MyOnCallView, MyShiftView } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { workspaceHref } from "@/lib/navigation";

/* Shown in the viewer's own time zone: it is their day the shift lands in. */
const when = (iso: string) =>
  new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

export function MyOnCall({ ws }: { ws: string }) {
  const t = useTranslations("oncall.mine");
  const mine = useQuery({
    queryKey: ["my-on-call", ws],
    queryFn: () => api<MyOnCallView>(wsPath(ws, "/me/on-call")),
    refetchInterval: 60_000,
  });
  const link = (shift: MyShiftView) => (
    <Link
      href={`${workspaceHref(ws, "on-call")}/${shift.scheduleId}`}
      className="font-medium underline-offset-4 hover:underline"
    >
      {shift.scheduleName}
    </Link>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        {mine.isPending ? (
          <Loading rows={1} />
        ) : mine.isError ? (
          <Alert tone="error">{errorMessage(mine.error)}</Alert>
        ) : (
          <>
            {mine.data.current.length === 0 ? (
              <p>{t("notNow")}</p>
            ) : (
              <ul className="grid gap-1" aria-label={t("now")}>
                {mine.data.current.map((shift) => (
                  <li key={`${shift.scheduleId}-${shift.endsAt}`}>
                    <span className="font-semibold">{t("onCallFor")}</span> {link(shift)}{" "}
                    {shift.source === "override"
                      ? t("untilOverride", { time: when(shift.endsAt) })
                      : t("until", { time: when(shift.endsAt) })}
                  </li>
                ))}
              </ul>
            )}
            {mine.data.upcoming.length === 0 ? (
              <p className="text-muted-foreground">{t("noUpcoming")}</p>
            ) : (
              <div className="grid gap-1">
                <p className="font-medium">{t("next")}</p>
                <ul className="grid gap-0.5 text-muted-foreground" aria-label={t("next")}>
                  {mine.data.upcoming.slice(0, 5).map((shift) => (
                    <li key={`${shift.scheduleId}-${shift.startsAt}`}>
                      {when(shift.startsAt)} – {when(shift.endsAt)} · {link(shift)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("hint")}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
