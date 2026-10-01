/* Landing page: what Watchpost does, sign in, sign up and plan selection. The full site is P3-T07. */
import Link from "next/link";
import {
  Activity,
  FileSearch,
  GitCommitHorizontal,
  MessagesSquare,
  Radar,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { PlanPicker } from "@/features/marketing/components/plan-picker";

const FEATURES = [
  { key: "confirmed", icon: ShieldCheck },
  { key: "evidence", icon: FileSearch },
  { key: "channels", icon: MessagesSquare },
  { key: "changes", icon: GitCommitHorizontal },
  { key: "tuning", icon: SlidersHorizontal },
  { key: "heartbeats", icon: Activity },
] as const;

export default async function HomePage() {
  const t = await getTranslations("marketing");
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <Radar aria-hidden className="size-5 text-brand" />
            Watchpost
          </Link>
          <nav aria-label={t("navLabel")} className="flex items-center gap-1 sm:gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href="#features">{t("navFeatures")}</a>
            </Button>
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <a href="#pricing">{t("navPricing")}</a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">{t("signIn")}</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/signup">{t("signUp")}</Link>
            </Button>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-20 text-center sm:px-6 sm:py-28">
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {t("hero")}
          </h1>
          <p className="text-lg text-muted-foreground text-pretty">{t("subhead")}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button asChild>
              <Link href="/signup">{t("startFreeNoCard")}</Link>
            </Button>
            <Button asChild variant="outline">
              <a href="#pricing">{t("seePlans")}</a>
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("haveAccount")}{" "}
            <Link href="/login" className="text-foreground underline">
              {t("signIn")}
            </Link>
          </p>
        </section>

        <section
          id="features"
          aria-labelledby="features-title"
          className="scroll-mt-20 border-t bg-muted/40"
        >
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6">
            <div className="mx-auto grid max-w-2xl gap-2 text-center">
              <h2 id="features-title" className="text-2xl font-semibold tracking-tight">
                {t("featuresTitle")}
              </h2>
              <p className="text-muted-foreground">{t("featuresIntro")}</p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ key, icon: Icon }) => (
                <li key={key} className="grid content-start gap-2 rounded-lg border bg-card p-5">
                  <Icon aria-hidden className="size-5 text-brand" />
                  <h3 className="font-semibold">{t(`features.${key}.title`)}</h3>
                  <p className="text-sm text-muted-foreground">{t(`features.${key}.body`)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 border-t">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6">
            <div className="mx-auto grid max-w-2xl gap-2 text-center">
              <h2 id="pricing-title" className="text-2xl font-semibold tracking-tight">
                {t("pricingTitle")}
              </h2>
              <p className="text-muted-foreground">{t("pricingIntro")}</p>
            </div>
            <PlanPicker />
          </div>
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>{t("footer")}</span>
          <span className="flex gap-4">
            <Link href="/login" className="hover:text-foreground">
              {t("signIn")}
            </Link>
            <Link href="/signup" className="hover:text-foreground">
              {t("signUp")}
            </Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
