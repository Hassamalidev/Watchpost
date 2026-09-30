import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MONITOR_STATUSES } from "@app/shared";
import { StatusBadge } from "@/components/app/status-badge";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage() {
  const t = await getTranslations("overview");
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("intro")}</p>
      </div>
      <section aria-labelledby="status-legend" className="rounded-lg border bg-card p-4">
        <h2 id="status-legend" className="mb-3 text-sm font-medium">
          {t("statusLegend")}
        </h2>
        <ul className="flex flex-wrap gap-2">
          {MONITOR_STATUSES.map((status) => (
            <li key={status}>
              <StatusBadge status={status} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
