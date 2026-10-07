/* Pricing: plan cards, the full comparison table, the per-seat calculator and questions. */
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlanPicker } from "@/features/marketing/components/plan-picker";
import { SeatCalculator } from "@/features/marketing/components/seat-calculator";
import { FAQ_KEYS, MARKETING_PLANS, PLAN_TABLE_ROWS } from "@/features/marketing/plans";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Uptime monitoring pricing with flat plans for the whole team, not per seat. Free plan with 20 monitors and no card; paid plans from $9 a month.",
  alternates: { canonical: "/pricing" },
};

export default async function PricingPage() {
  const t = await getTranslations("marketing");
  return (
    <div className="mx-auto grid max-w-6xl gap-16 px-4 py-16 sm:px-6">
      <section className="grid gap-10">
        <div className="mx-auto grid max-w-2xl gap-2 text-center">
          <h1 className="text-4xl font-semibold tracking-tight">{t("pricingPageTitle")}</h1>
          <p className="text-lg text-muted-foreground text-pretty">{t("pricingPageIntro")}</p>
        </div>
        <PlanPicker />
      </section>

      <section aria-labelledby="table-title" className="grid gap-4">
        <h2 id="table-title" className="scroll-mt-20 text-2xl font-semibold tracking-tight">
          {t("tableTitle")}
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[44rem] text-sm">
            <caption className="sr-only">{t("tableCaption")}</caption>
            <thead className="bg-muted/60 text-left">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  {t("tableFeature")}
                </th>
                {MARKETING_PLANS.map((plan) => (
                  <th key={plan.key} scope="col" className="px-4 py-2 font-medium">
                    {t(`plans.${plan.key}.name`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PLAN_TABLE_ROWS.map((row) => (
                <tr key={row.key} className="border-t align-top">
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    {t(`table.${row.key}.label`)}
                    {row.soon && (
                      <span className="ml-2 inline-block rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {t("comingSoon")}
                      </span>
                    )}
                  </th>
                  {MARKETING_PLANS.map((plan) => (
                    <td key={plan.key} className="px-4 py-2">
                      {t(`table.${row.key}.${plan.key}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground">{t("tableCaption")}</p>
      </section>

      <section aria-labelledby="calculator-title" className="grid gap-4">
        <div className="grid gap-2">
          <h2 id="calculator-title" className="scroll-mt-20 text-2xl font-semibold tracking-tight">
            {t("calculatorTitle")}
          </h2>
          <p className="max-w-2xl text-muted-foreground">{t("calculatorIntro")}</p>
        </div>
        <SeatCalculator />
      </section>

      <section aria-labelledby="faq-title" className="grid gap-4">
        <h2 id="faq-title" className="scroll-mt-20 text-2xl font-semibold tracking-tight">
          {t("faqTitle")}
        </h2>
        <dl className="grid gap-6 md:grid-cols-2">
          {FAQ_KEYS.map((key) => (
            <div key={key} className="grid content-start gap-1">
              <dt className="font-medium">{t(`faq.q${key}`)}</dt>
              <dd className="text-sm text-muted-foreground">{t(`faq.a${key}`)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
