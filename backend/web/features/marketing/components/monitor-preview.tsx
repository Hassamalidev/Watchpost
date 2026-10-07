/*
 * A drawing of a monitor page for the landing page, built from markup so it follows the theme and
 * costs no image download. It shows example data and is hidden from screen readers, which get the
 * caption instead.
 */
import {
  Activity,
  ArrowUp,
  CalendarClock,
  CircleCheck,
  Globe,
  Plug,
  Radar,
  Siren,
  TriangleAlert,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SITE_NAME } from "@/lib/site";

const NAV = [
  { key: "monitors", icon: Activity, active: true },
  { key: "incidents", icon: Siren },
  { key: "onCall", icon: CalendarClock },
  { key: "statusPages", icon: Globe },
  { key: "integrations", icon: Plug },
] as const;

const STATS = [
  { label: "currentStatus", value: "up", note: "upFor", up: true },
  { label: "lastCheck", value: "lastCheckValue", note: "lastCheckNote" },
  { label: "last24", value: "last24Value", note: "last24Note", bars: true },
  { label: "certificate", value: "certificateValue", note: "certificateNote" },
] as const;

const REGIONS = [
  { key: "frankfurt", ms: "172 ms", slow: false },
  { key: "virginia", ms: "201 ms", slow: false },
  { key: "singapore", ms: "1,240 ms", slow: true },
] as const;

const BARS = Array.from({ length: 30 }, (_, index) => index);

/* Response times across the day, with the one spike the caption talks about. */
const LINE =
  "0,70 30,66 60,69 90,63 120,67 150,64 180,68 210,62 240,66 270,18 290,60 320,65 350,61 380,66 410,63 440,67 470,62 500,65 530,60 560,64 600,62";

export async function MonitorPreview() {
  const t = await getTranslations("marketing.landing.preview");
  return (
    <figure className="mx-auto w-full max-w-5xl">
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-xl border bg-card text-left text-card-foreground shadow-2xl shadow-brand/10"
      >
        <div className="grid md:grid-cols-[12rem_1fr]">
          <div className="hidden border-r bg-sidebar p-4 text-sidebar-foreground md:block">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <Radar className="size-4 text-brand" />
              {SITE_NAME}
            </p>
            <ul className="mt-5 grid gap-1 text-xs">
              {NAV.map(({ key, icon: Icon, ...item }) => (
                <li
                  key={key}
                  className={
                    "active" in item
                      ? "flex items-center gap-2 rounded-md bg-accent px-2 py-1.5 font-medium text-accent-foreground"
                      : "flex items-center gap-2 px-2 py-1.5 text-muted-foreground"
                  }
                >
                  <Icon className="size-3.5" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>

          <div className="grid gap-4 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-full bg-status-up text-background">
                  <ArrowUp className="size-5" />
                </span>
                <div>
                  <p className="font-semibold">api.example.com</p>
                  <p className="text-xs text-muted-foreground">{t("kind")}</p>
                </div>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-status-up/50 px-2.5 py-1 text-xs font-medium text-status-up">
                <CircleCheck className="size-3.5" />
                {t("up")}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {STATS.map((stat) => (
                <div key={stat.label} className="grid content-start gap-1 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{t(stat.label)}</p>
                  <p
                    className={
                      "up" in stat
                        ? "text-sm font-semibold text-status-up"
                        : "text-sm font-semibold"
                    }
                  >
                    {t(stat.value)}
                  </p>
                  {"bars" in stat && (
                    <div className="flex gap-px">
                      {BARS.map((bar) => (
                        <span key={bar} className="h-4 flex-1 rounded-[1px] bg-status-up" />
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">{t(stat.note)}</p>
                </div>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_15rem]">
              <div className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-medium">{t("responseTime")}</p>
                  <p className="text-xs text-muted-foreground">{t("responseRange")}</p>
                </div>
                <svg viewBox="0 0 600 80" preserveAspectRatio="none" className="h-24 w-full">
                  <polygon
                    points={`0,80 ${LINE} 600,80`}
                    fill="var(--brand)"
                    opacity="0.12"
                    stroke="none"
                  />
                  <polyline
                    points={LINE}
                    fill="none"
                    stroke="var(--brand)"
                    strokeWidth="2"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>

              <div className="grid content-start gap-2 rounded-lg border p-3">
                <p className="text-xs font-medium">{t("regions")}</p>
                <ul className="grid gap-1.5 text-xs">
                  {REGIONS.map((region) => (
                    <li key={region.key} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        {region.slow ? (
                          <TriangleAlert className="size-3.5 text-status-degraded" />
                        ) : (
                          <CircleCheck className="size-3.5 text-status-up" />
                        )}
                        {t(region.key)}
                      </span>
                      <span className="font-mono text-muted-foreground">{region.ms}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 grid gap-0.5 rounded-md bg-muted p-2 text-xs">
                  <p className="font-medium">{t("confirmedTitle")}</p>
                  <p className="text-muted-foreground">{t("confirmedBody")}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="sr-only">{t("caption")}</figcaption>
    </figure>
  );
}
