/* Comparison with one competitor: reported facts, dated, with their sources. */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { CHECKED_ON, COMPETITORS, findCompetitor } from "@/features/marketing/competitors";

type Props = { params: Promise<{ competitor: string }> };

export const dynamicParams = false;

export const generateStaticParams = () =>
  COMPETITORS.map((competitor) => ({ competitor: competitor.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const competitor = findCompetitor((await params).competitor);
  return competitor ? { title: `Watchpost vs ${competitor.name}` } : {};
}

export default async function ComparePage({ params }: Props) {
  const competitor = findCompetitor((await params).competitor);
  if (!competitor) notFound();
  const t = await getTranslations("marketing");
  const { name } = competitor;

  return (
    <article className="mx-auto grid max-w-3xl gap-8 px-4 py-12 sm:px-6">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t("compareTitle", { name })}</h1>
        <p className="text-muted-foreground">{t("compareIntro")}</p>
      </header>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("compareWhatItIs", { name })}</h2>
        <p>{competitor.model}</p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("comparePricing")}</h2>
        <p className="text-pretty">{competitor.pricing}</p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("compareGoodFit", { name })}</h2>
        <p className="text-pretty">{competitor.goodFit}</p>
      </section>

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">{t("compareDifferences")}</h2>
        <ul className="grid list-disc gap-1.5 pl-5">
          {competitor.differences.map((difference) => (
            <li key={difference}>{difference}</li>
          ))}
        </ul>
      </section>

      <section className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-sm">
        <h2 className="font-semibold">{t("compareSources")}</h2>
        <p className="text-muted-foreground">{t("compareChecked", { date: CHECKED_ON, name })}</p>
        <ul className="grid gap-1 break-all">
          {competitor.sources.map((source) => (
            <li key={source}>
              <a href={source} rel="noopener noreferrer nofollow" className="underline">
                {source}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap gap-3">
        <Button asChild>
          <Link href="/signup">{t("compareCta")}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/pricing">{t("navPricing")}</Link>
        </Button>
      </div>
    </article>
  );
}
