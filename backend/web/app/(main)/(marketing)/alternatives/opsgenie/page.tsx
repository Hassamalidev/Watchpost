/*
 * Moving from Opsgenie: the dates as reported (with sources), what UptimeWatch covers, how the move
 * works, and where to start. Copy needs the owner's approval before launch (PRODUCT.md P4-T10); no
 * offer is shown until Open decision #9 is made.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { CHECKED_ON, findCompetitor } from "@/features/marketing/competitors";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("alternatives.opsgenie");
  return {
    title: t("metaTitle"),
    description: t("lead"),
    alternates: { canonical: "/alternatives/opsgenie" },
  };
}

const COVERS = ["schedules", "escalation", "reach", "chat", "inbound", "monitoring"] as const;
const STEPS = ["import", "parallel", "switch"] as const;

export default async function OpsgenieAlternativePage() {
  const t = await getTranslations("alternatives.opsgenie");
  const sources = findCompetitor("opsgenie")?.sources ?? [];

  return (
    <article className="mx-auto grid max-w-3xl gap-10 px-4 py-12 sm:px-6">
      <header className="grid gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          {t("title")}
        </h1>
        <p className="text-lg text-pretty text-muted-foreground">{t("lead")}</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/signup" className={buttonVariants()}>
            {t("cta")}
          </Link>
          <Link
            href="/docs/migrate-from-opsgenie"
            className={buttonVariants({ variant: "outline" })}
          >
            {t("guide")}
          </Link>
        </div>
        <p className="text-sm text-muted-foreground">{t("noCard")}</p>
      </header>

      <section className="grid gap-3" aria-labelledby="dates-heading">
        <h2 id="dates-heading" className="text-xl font-semibold">
          {t("datesTitle")}
        </h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          <li>{t("dateSales")}</li>
          <li>{t("dateSupport")}</li>
          <li>{t("dateData")}</li>
        </ul>
        <p className="text-sm text-muted-foreground">{t("datesNote", { date: CHECKED_ON })}</p>
      </section>

      <section className="grid gap-3" aria-labelledby="covers-heading">
        <h2 id="covers-heading" className="text-xl font-semibold">
          {t("coversTitle")}
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          {COVERS.map((key) => (
            <div key={key} className="grid gap-1 rounded-lg border p-4">
              <dt className="font-medium">{t(`covers.${key}.title`)}</dt>
              <dd className="text-sm text-pretty text-muted-foreground">
                {t(`covers.${key}.body`)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-3" aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="text-xl font-semibold">
          {t("stepsTitle")}
        </h2>
        <ol className="grid list-decimal gap-3 pl-5">
          {STEPS.map((key) => (
            <li key={key}>
              <span className="font-medium">{t(`steps.${key}.title`)}</span>{" "}
              <span className="text-pretty">{t(`steps.${key}.body`)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-3" aria-labelledby="honest-heading">
        <h2 id="honest-heading" className="text-xl font-semibold">
          {t("honestTitle")}
        </h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          <li>{t("honest.heartbeats")}</li>
          <li>{t("honest.integrations")}</li>
          <li>{t("honest.mobile")}</li>
        </ul>
      </section>

      <section className="grid gap-3 rounded-lg border bg-muted/40 p-5">
        <h2 className="text-lg font-semibold">{t("pricingTitle")}</h2>
        <p className="text-pretty">{t("pricingBody")}</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/pricing" className={buttonVariants({ variant: "outline" })}>
            {t("pricingLink")}
          </Link>
          <Link href="/compare/opsgenie" className={buttonVariants({ variant: "ghost" })}>
            {t("compareLink")}
          </Link>
        </div>
      </section>

      <section className="grid gap-2 text-sm">
        <h2 className="font-semibold">{t("sourcesTitle")}</h2>
        <ul className="grid gap-1">
          {sources.map((source) => (
            <li key={source}>
              <a href={source} rel="noreferrer" className="break-all underline">
                {source}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </article>
  );
}
