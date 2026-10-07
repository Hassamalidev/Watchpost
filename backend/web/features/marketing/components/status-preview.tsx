/*
 * A drawing of a public status page for the landing page: example data, built from markup, hidden
 * from screen readers, which get the caption instead.
 */
import { CircleCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";

/* Each component with the day (counted from the left) that had a degraded spell, if any. */
const COMPONENTS = [
  { key: "website", degraded: -1 },
  { key: "api", degraded: 31 },
  { key: "dashboard", degraded: -1 },
] as const;

const DAYS = Array.from({ length: 45 }, (_, index) => index);

export async function StatusPreview() {
  const t = await getTranslations("marketing.landing.statusMock");
  return (
    <figure className="w-full">
      <div
        aria-hidden="true"
        className="forced-color-adjust-none grid gap-4 rounded-xl border bg-card p-5 text-card-foreground shadow-xl shadow-brand/10 sm:p-6"
      >
        <p className="text-sm font-semibold">{t("name")}</p>
        <p className="flex items-center gap-2 rounded-lg border border-status-up/50 px-3 py-2.5 text-sm font-medium text-status-up">
          <CircleCheck className="size-4" />
          {t("allGood")}
        </p>
        <ul className="grid gap-4">
          {COMPONENTS.map((component) => (
            <li key={component.key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium">{t(component.key)}</span>
                <span className="text-xs text-status-up">{t("operational")}</span>
              </div>
              <div className="flex gap-0.5">
                {DAYS.map((day) => (
                  <span
                    key={day}
                    className={
                      day === component.degraded
                        ? "h-6 flex-1 rounded-[2px] bg-status-degraded"
                        : "h-6 flex-1 rounded-[2px] bg-status-up"
                    }
                  />
                ))}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t("days")}</span>
                <span>{t("today")}</span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="sr-only">{t("caption")}</figcaption>
    </figure>
  );
}
