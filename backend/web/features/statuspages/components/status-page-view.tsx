/*
 * What visitors see on a status page: the banner, open incidents, maintenance, the components with
 * their 90-day bars, and recent history. It has no state and no effects, so the public page renders
 * it on the server with almost no JavaScript and the editor reuses it for its live preview.
 * Status is always an icon and words, never color alone (PRODUCT.md §14).
 */
import type * as React from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  MinusCircle,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  ComponentStatus,
  PublicMaintenance,
  PublicStatusComponent,
  PublicStatusIncident,
  PublicStatusPage,
  PublicUptimeDay,
} from "@app/shared";

const STATUS_STYLE: Record<ComponentStatus, { icon: LucideIcon; text: string; bar: string }> = {
  operational: { icon: CheckCircle2, text: "text-status-up", bar: "bg-status-up" },
  degraded: { icon: MinusCircle, text: "text-status-degraded", bar: "bg-status-degraded" },
  partial_outage: { icon: AlertTriangle, text: "text-status-degraded", bar: "bg-status-degraded" },
  major_outage: { icon: XCircle, text: "text-status-down", bar: "bg-status-down" },
  maintenance: { icon: Wrench, text: "text-status-maintenance", bar: "bg-status-maintenance" },
  unknown: { icon: CircleHelp, text: "text-status-pending", bar: "bg-status-pending" },
};

const DAY_FILL: Record<PublicUptimeDay["status"], string> = {
  up: "var(--status-up)",
  minor: "var(--status-degraded)",
  major: "var(--status-down)",
  none: "var(--border)",
};

export const SUBSCRIBE_NOTICES = ["sent", "confirmed", "removed"] as const;
export type SubscribeNotice = (typeof SUBSCRIBE_NOTICES)[number];

/* Dates are written in UTC with fixed formats, so the server and the browser print the same text. */
const dateTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
});
export const formatUtc = (iso: string) => `${dateTime.format(new Date(iso))} UTC`;

/* Components in page order, with those of the same group kept together under its name. */
export function groupComponents(
  components: readonly PublicStatusComponent[],
): Array<{ group: string | null; items: PublicStatusComponent[] }> {
  const sections: Array<{ group: string | null; items: PublicStatusComponent[] }> = [];
  for (const c of components) {
    const existing = c.group === null ? undefined : sections.find((s) => s.group === c.group);
    if (existing) existing.items.push(c);
    else sections.push({ group: c.group, items: [c] });
  }
  return sections;
}

function UptimeBars({ name, uptime }: { name: string; uptime: PublicStatusComponent["uptime"] }) {
  const t = useTranslations("statusPage");
  if (uptime === null) return null;
  const percent =
    uptime.percent === null ? t("noData") : t("uptimePercent", { percent: uptime.percent });
  const width = 3;
  const gap = 1;
  return (
    <div className="mt-2">
      <svg
        role="img"
        aria-label={t("uptimeLabel", { name, days: uptime.days.length, percent })}
        viewBox={`0 0 ${uptime.days.length * (width + gap) - gap} 24`}
        preserveAspectRatio="none"
        className="h-6 w-full"
      >
        {uptime.days.map((day, index) => (
          <rect
            key={day.date}
            x={index * (width + gap)}
            y={0}
            width={width}
            height={24}
            rx={1}
            fill={DAY_FILL[day.status]}
          >
            <title>
              {day.uptimePercent === null
                ? `${day.date}: ${t("noData")}`
                : `${day.date}: ${t("uptimePercent", { percent: day.uptimePercent })}`}
            </title>
          </rect>
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground">
        <span>{t("daysAgo", { days: uptime.days.length })}</span>
        <span>{percent}</span>
        <span>{t("today")}</span>
      </div>
    </div>
  );
}

function ComponentRow({ component }: { component: PublicStatusComponent }) {
  const t = useTranslations("statusPage");
  const style = STATUS_STYLE[component.status];
  const Icon = style.icon;
  return (
    <li className="px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium">{component.name}</p>
          {component.description && (
            <p className="text-sm text-muted-foreground">{component.description}</p>
          )}
        </div>
        <p className={`flex shrink-0 items-center gap-1.5 text-sm font-medium ${style.text}`}>
          <Icon aria-hidden className="size-4" />
          {t(`component.${component.status}`)}
        </p>
      </div>
      <UptimeBars name={component.name} uptime={component.uptime} />
    </li>
  );
}

function IncidentCard({ incident }: { incident: PublicStatusIncident }) {
  const t = useTranslations("statusPage");
  return (
    <article id={`incident-${incident.id}`} className="rounded-lg border bg-card p-4">
      <h3 className="font-semibold">{incident.title}</h3>
      {incident.components.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("affects", { components: incident.components.join(", ") })}
        </p>
      )}
      <ol className="mt-3 grid gap-3">
        {incident.updates.map((update) => (
          <li key={update.id} className="border-l-2 pl-3 text-sm">
            <p>
              <span className="font-medium">{t(`incident.${update.status}`)}</span>
              <span className="text-muted-foreground"> · </span>
              <time className="text-muted-foreground" dateTime={update.at}>
                {formatUtc(update.at)}
              </time>
            </p>
            <p className="whitespace-pre-wrap">{update.message}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function MaintenanceCard({ window }: { window: PublicMaintenance }) {
  const t = useTranslations("statusPage");
  return (
    <article className="rounded-lg border bg-card p-4 text-sm">
      <h3 className="flex items-center gap-2 font-semibold">
        <Wrench aria-hidden className="size-4 text-status-maintenance" />
        {window.name}
      </h3>
      <p className="text-muted-foreground">
        {window.active
          ? window.endsAt === null
            ? t("maintenanceNow")
            : t("maintenanceUntil", { time: formatUtc(window.endsAt) })
          : window.startsAt !== null && window.endsAt !== null
            ? t("maintenanceFrom", {
                start: formatUtc(window.startsAt),
                end: formatUtc(window.endsAt),
              })
            : null}
      </p>
      {window.components.length > 0 && (
        <p className="text-muted-foreground">
          {t("affects", { components: window.components.join(", ") })}
        </p>
      )}
    </article>
  );
}

export function StatusPageView({
  data,
  feedBase,
  embedded = false,
  subscribeAction,
  notice,
}: {
  data: PublicStatusPage;
  /* Where the page's JSON and feeds are served; omitted in the editor's preview. */
  feedBase?: string;
  /* Inside another page (the editor's preview): the title is not that page's main heading. */
  embedded?: boolean;
  /* Where the subscribe form posts; the form is shown when the page takes subscribers. */
  subscribeAction?: string;
  /* What just happened with the visitor's subscription, to say so at the top. */
  notice?: SubscribeNotice | undefined;
}): React.ReactElement {
  const t = useTranslations("statusPage");
  const { page } = data;
  const banner = STATUS_STYLE[data.status];
  const BannerIcon = banner.icon;
  const accent = page.branding.accentColor;
  const Title = embedded ? "h2" : "h1";
  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col gap-8 px-4 py-10"
      style={accent ? ({ "--page-accent": accent } as React.CSSProperties) : undefined}
    >
      <header className="grid gap-2">
        <div className="flex items-center gap-3">
          {page.branding.logoUrl && (
            /* A plain img: the logo is the customer's own file on any host. */
            <img src={page.branding.logoUrl} alt="" className="h-9 w-auto max-w-40" />
          )}
          <Title className="text-2xl font-semibold tracking-tight">
            {t("title", { name: page.name })}
          </Title>
        </div>
        {page.branding.description && (
          <p className="text-muted-foreground">{page.branding.description}</p>
        )}
      </header>

      {notice && (
        <p role="status" className="rounded-lg border bg-muted p-3 text-sm">
          {t(`subscribe.notice.${notice}`)}
        </p>
      )}

      <section
        aria-label={t("current")}
        className="flex items-center gap-3 rounded-lg border bg-card p-4"
        style={accent ? { borderLeft: "4px solid var(--page-accent)" } : undefined}
      >
        <BannerIcon aria-hidden className={`size-6 shrink-0 ${banner.text}`} />
        <p className="text-lg font-semibold">{t(`overall.${data.status}`)}</p>
      </section>

      {data.incidents.active.length > 0 && (
        <section aria-labelledby="sp-active" className="grid gap-3">
          <h2 id="sp-active" className="text-lg font-semibold">
            {t("activeIncidents")}
          </h2>
          {data.incidents.active.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))}
        </section>
      )}

      {data.maintenance.length > 0 && (
        <section aria-labelledby="sp-maintenance" className="grid gap-3">
          <h2 id="sp-maintenance" className="text-lg font-semibold">
            {t("maintenance")}
          </h2>
          {data.maintenance.map((window) => (
            <MaintenanceCard key={window.id} window={window} />
          ))}
        </section>
      )}

      <section aria-labelledby="sp-components" className="grid gap-3">
        <h2 id="sp-components" className="text-lg font-semibold">
          {t("components")}
        </h2>
        {data.components.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noComponents")}</p>
        ) : (
          groupComponents(data.components).map((section, index) => (
            <div key={section.group ?? `single-${index}`} className="rounded-lg border bg-card">
              {section.group && (
                <h3 className="border-b px-4 py-2 text-sm font-semibold">{section.group}</h3>
              )}
              <ul className="divide-y">
                {section.items.map((component) => (
                  <ComponentRow key={component.id} component={component} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <section aria-labelledby="sp-history" className="grid gap-3">
        <h2 id="sp-history" className="text-lg font-semibold">
          {t("history")}
        </h2>
        {data.incidents.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noHistory")}</p>
        ) : (
          data.incidents.recent.map((incident) => (
            <IncidentCard key={incident.id} incident={incident} />
          ))
        )}
      </section>

      {page.subscribe && subscribeAction && (
        <section
          aria-labelledby="sp-subscribe"
          className="grid gap-2 rounded-lg border bg-card p-4"
        >
          <h2 id="sp-subscribe" className="text-lg font-semibold">
            {t("subscribe.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("subscribe.intro")}</p>
          {/* A plain form post: subscribing works without JavaScript. */}
          <form method="post" action={subscribeAction} className="flex flex-wrap items-end gap-2">
            <label className="grid min-w-0 flex-1 gap-1 text-sm font-medium">
              {t("subscribe.email")}
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                maxLength={320}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal"
              />
            </label>
            <button
              type="submit"
              className="h-9 rounded-md bg-foreground px-4 text-sm font-medium text-background"
            >
              {t("subscribe.button")}
            </button>
          </form>
        </section>
      )}

      <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-sm text-muted-foreground">
        <p>
          <time dateTime={data.generatedAt}>
            {t("updated", { time: formatUtc(data.generatedAt) })}
          </time>
        </p>
        <nav aria-label={t("feeds")} className="flex flex-wrap gap-4">
          {page.branding.supportUrl && (
            <a className="underline underline-offset-4" href={page.branding.supportUrl}>
              {t("support")}
            </a>
          )}
          {feedBase && (
            <>
              <a className="underline underline-offset-4" href={`${feedBase}/rss`}>
                RSS
              </a>
              <a className="underline underline-offset-4" href={`${feedBase}/atom`}>
                Atom
              </a>
              <a className="underline underline-offset-4" href={feedBase}>
                JSON
              </a>
            </>
          )}
          <a className="underline underline-offset-4" href={page.poweredByUrl}>
            {t("poweredBy")}
          </a>
        </nav>
      </footer>
    </div>
  );
}
