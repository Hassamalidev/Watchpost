/*
 * Landing page: what UptimeWatch monitors, how it confirms an outage, status pages, on-call, alert
 * channels, plans and questions. Every claim is something the product does today or is marked as
 * coming soon; there are no customer logos, counts or ratings because there are none to show yet.
 */
import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Braces,
  Cable,
  Check,
  Clock,
  FileSearch,
  GitCommitHorizontal,
  Globe,
  KeyRound,
  LockKeyhole,
  MessagesSquare,
  Network,
  Plus,
  Server,
  ShieldCheck,
  Signal,
  SlidersHorizontal,
} from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button, buttonVariants } from "@/components/ui/button";
import { findCompetitor } from "@/features/marketing/competitors";
import { MonitorPreview } from "@/features/marketing/components/monitor-preview";
import { PlanPicker } from "@/features/marketing/components/plan-picker";
import { StatusPreview } from "@/features/marketing/components/status-preview";
import { MARKETING_PLANS } from "@/features/marketing/plans";
import { SITE_DESCRIPTION, landingJsonLd, serializeJsonLd } from "@/lib/site";
import { cn } from "@/lib/utils";

const TITLE = "Uptime Monitoring, On-Call and Status Pages | UptimeWatch";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

const HERO_CHECKS = ["free", "regions", "channels", "statusPages"] as const;

const MONITOR_TYPES = [
  { key: "http", icon: Globe },
  { key: "keyword", icon: KeyRound },
  { key: "json", icon: Braces },
  { key: "ping", icon: Signal },
  { key: "port", icon: Network },
  { key: "dns", icon: Server },
  { key: "ssl", icon: LockKeyhole },
  { key: "cron", icon: Clock },
  { key: "websocket", icon: Cable },
] as const;

const STEPS = ["check", "confirm", "alert", "communicate"] as const;

const FEATURES = [
  { key: "confirmed", icon: ShieldCheck },
  { key: "evidence", icon: FileSearch },
  { key: "channels", icon: MessagesSquare },
  { key: "changes", icon: GitCommitHorizontal },
  { key: "tuning", icon: SlidersHorizontal },
  { key: "heartbeats", icon: Activity },
] as const;

const STATUS_POINTS = ["domain", "components", "incidents", "subscribers", "badges"] as const;

/* Product names, the same in every language. SMS and voice are left out until they are live. */
const CHANNELS = [
  "Email",
  "Slack",
  "Microsoft Teams",
  "Discord",
  "Telegram",
  "Google Chat",
  "Mattermost",
  "Rocket.Chat",
  "Zulip",
  "Matrix",
  "PagerDuty",
  "Opsgenie",
  "Splunk On-Call",
  "Pushover",
  "ntfy",
  "Pushbullet",
  "Gotify",
  "Webhooks",
] as const;

/* Tools with an importer and a comparison page. */
const MIGRATE_FROM = ["uptimerobot", "uptime-kuma", "better-stack"] as const;

const FAQ = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

function SectionHeading({ id, title, intro }: { id: string; title: string; intro: string }) {
  return (
    <div className="mx-auto grid max-w-2xl gap-3 text-center">
      <h2 id={id} className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        {title}
      </h2>
      <p className="text-lg text-muted-foreground text-pretty">{intro}</p>
    </div>
  );
}

export default async function HomePage() {
  const t = await getTranslations("marketing");
  const l = await getTranslations("marketing.landing");

  const faq = FAQ.map((key) => ({ question: l(`faq.q${key}`), answer: l(`faq.a${key}`) }));
  const jsonLd = landingJsonLd({
    faq,
    offers: MARKETING_PLANS.map((plan) => ({
      name: t(`plans.${plan.key}.name`),
      price: plan.monthly,
    })),
    features: MONITOR_TYPES.map(({ key }) => l(`monitors.${key}.title`)),
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      <section className="relative isolate overflow-hidden">
        <div aria-hidden="true" className="landing-grid absolute inset-0 -z-10" />
        <div aria-hidden="true" className="landing-glow absolute inset-0 -z-10" />
        <div className="mx-auto grid max-w-6xl gap-12 px-4 pt-16 pb-20 sm:px-6 sm:pt-24">
          <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 text-center">
            <p className="inline-flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-sm text-muted-foreground">
              <span className="size-2 rounded-full bg-status-up" />
              {l("eyebrow")}
            </p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
              <span className="text-brand">{l("heroLead")}</span> {l("heroRest")}
            </h1>
            <p className="max-w-2xl text-lg text-muted-foreground text-pretty">{t("subhead")}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button asChild className="h-11 px-6 text-base">
                <Link href="/signup">
                  {t("startFreeNoCard")}
                  <ArrowRight aria-hidden />
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-11 px-6 text-base">
                <a href="#pricing">{t("seePlans")}</a>
              </Button>
            </div>
            <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
              {HERO_CHECKS.map((key) => (
                <li key={key} className="flex items-center gap-1.5">
                  <Check aria-hidden className="size-4 text-status-up" />
                  {l(`checks.${key}`)}
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground">
              {t("haveAccount")}{" "}
              <Link href="/login" className="text-foreground underline">
                {t("signIn")}
              </Link>
            </p>
          </div>
          <MonitorPreview />
        </div>
      </section>

      <section id="monitors" aria-labelledby="monitors-title" className="scroll-mt-20 border-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6">
          <SectionHeading
            id="monitors-title"
            title={l("monitorsTitle")}
            intro={l("monitorsIntro")}
          />
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {MONITOR_TYPES.map(({ key, icon: Icon }) => (
              <li
                key={key}
                className="grid content-start gap-3 rounded-xl border bg-card p-6 transition-colors hover:border-brand/60"
              >
                <span className="grid size-11 place-items-center rounded-full border bg-background">
                  <Icon aria-hidden className="size-5 text-brand" />
                </span>
                <h3 className="text-lg font-semibold">{l(`monitors.${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground">{l(`monitors.${key}.body`)}</p>
              </li>
            ))}
          </ul>
          <p className="text-center">
            <Link
              href="/docs/monitors"
              className="inline-flex items-center gap-1 text-sm font-medium underline"
            >
              {l("monitorsLink")}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          </p>
        </div>
      </section>

      <section
        id="how-it-works"
        aria-labelledby="steps-title"
        className="scroll-mt-20 border-t bg-muted/40"
      >
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6">
          <SectionHeading id="steps-title" title={l("stepsTitle")} intro={l("stepsIntro")} />
          <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((key, index) => (
              <li key={key} className="grid content-start gap-2 rounded-xl border bg-card p-6">
                <span
                  aria-hidden="true"
                  className="grid size-8 place-items-center rounded-full bg-brand font-mono text-sm font-semibold text-brand-foreground"
                >
                  {index + 1}
                </span>
                <h3 className="text-lg font-semibold">{l(`steps.${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground">{l(`steps.${key}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="features" aria-labelledby="features-title" className="scroll-mt-20 border-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6">
          <SectionHeading
            id="features-title"
            title={t("featuresTitle")}
            intro={t("featuresIntro")}
          />
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ key, icon: Icon }) => (
              <li key={key} className="grid content-start gap-2 rounded-xl border bg-card p-6">
                <Icon aria-hidden className="size-5 text-brand" />
                <h3 className="font-semibold">{t(`features.${key}.title`)}</h3>
                <p className="text-sm text-muted-foreground">{t(`features.${key}.body`)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section
        id="status-pages"
        aria-labelledby="status-title"
        className="scroll-mt-20 border-t bg-muted/40"
      >
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div className="grid gap-6">
            <div className="grid gap-3">
              <h2
                id="status-title"
                className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
              >
                {l("statusTitle")}
              </h2>
              <p className="text-lg text-muted-foreground text-pretty">{l("statusIntro")}</p>
            </div>
            <ul className="grid gap-3">
              {STATUS_POINTS.map((key) => (
                <li key={key} className="flex items-start gap-2">
                  <Check aria-hidden className="mt-1 size-4 shrink-0 text-status-up" />
                  {l(`statusPoints.${key}`)}
                </li>
              ))}
            </ul>
            <p>
              <Link href="/signup" className={buttonVariants({ variant: "outline" })}>
                {l("statusCta")}
                <ArrowRight aria-hidden />
              </Link>
            </p>
          </div>
          <StatusPreview />
        </div>
      </section>

      <section aria-labelledby="oncall-title" className="border-t">
        <div className="mx-auto grid max-w-6xl gap-4 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div className="grid content-start gap-4 rounded-xl border bg-card p-6 sm:p-8">
            <h2 id="oncall-title" className="text-2xl font-semibold tracking-tight text-balance">
              {l("onCallTitle")}
            </h2>
            <p className="text-muted-foreground text-pretty">{l("onCallBody")}</p>
            <p className="text-sm text-muted-foreground">{l("onCallNote")}</p>
            <p>
              <Link
                href="/pricing#calculator-title"
                className="inline-flex items-center gap-1 text-sm font-medium underline"
              >
                {l("onCallCta")}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </p>
          </div>
          <div className="grid content-start gap-4 rounded-xl border bg-card p-6 sm:p-8">
            <h2 className="text-2xl font-semibold tracking-tight text-balance">
              {l("channelsTitle")}
            </h2>
            <p className="text-muted-foreground text-pretty">{l("channelsBody")}</p>
            <ul aria-label={l("channelsList")} className="flex flex-wrap gap-2">
              {CHANNELS.map((channel) => (
                <li key={channel} className="rounded-full border bg-background px-3 py-1 text-sm">
                  {channel}
                </li>
              ))}
            </ul>
            <p>
              <Link
                href="/docs/alert-channels"
                className="inline-flex items-center gap-1 text-sm font-medium underline"
              >
                {l("channelsCta")}
                <ArrowRight aria-hidden className="size-4" />
              </Link>
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="migrate-title" className="border-t bg-muted/40">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-16 sm:px-6 lg:grid-cols-[1fr_auto] lg:items-center">
          <div className="grid max-w-2xl gap-3">
            <h2 id="migrate-title" className="text-2xl font-semibold tracking-tight text-balance">
              {l("migrateTitle")}
            </h2>
            <p className="text-muted-foreground text-pretty">{l("migrateBody")}</p>
          </div>
          <ul className="flex flex-wrap gap-2">
            {MIGRATE_FROM.map((slug) => (
              <li key={slug}>
                <Link
                  href={`/compare/${slug}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {l("migrateCompare", { name: findCompetitor(slug)?.name ?? slug })}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href="/alternatives/opsgenie"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                {l("migrateOpsgenie")}
              </Link>
            </li>
          </ul>
        </div>
      </section>

      <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-20 border-t">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6">
          <SectionHeading id="pricing-title" title={t("pricingTitle")} intro={t("pricingIntro")} />
          <PlanPicker />
          <p className="text-center">
            <Link href="/pricing" className="text-sm font-medium underline">
              {t("compareAll")}
            </Link>
          </p>
        </div>
      </section>

      <section id="faq" aria-labelledby="faq-title" className="scroll-mt-20 border-t bg-muted/40">
        <div className="mx-auto grid max-w-3xl gap-8 px-4 py-20 sm:px-6">
          <h2
            id="faq-title"
            className="text-center text-3xl font-semibold tracking-tight sm:text-4xl"
          >
            {l("faqTitle")}
          </h2>
          <div className="grid gap-3">
            {faq.map((entry, index) => (
              <details
                key={entry.question}
                open={index === 0}
                className="group rounded-xl border bg-card px-5"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-medium [&::-webkit-details-marker]:hidden">
                  {entry.question}
                  <Plus
                    aria-hidden
                    className="size-5 shrink-0 text-brand transition-transform group-open:rotate-45"
                  />
                </summary>
                <p className="pb-5 text-muted-foreground text-pretty">{entry.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="cta-title" className="relative isolate overflow-hidden border-t">
        <div aria-hidden="true" className="landing-glow absolute inset-0 -z-10" />
        <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-24 text-center sm:px-6">
          <h2
            id="cta-title"
            className="text-3xl font-semibold tracking-tight text-balance sm:text-5xl"
          >
            {l("ctaTitle")}
          </h2>
          <p className="text-lg text-muted-foreground text-pretty">{l("ctaBody")}</p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/signup"
              className={cn(buttonVariants({ variant: "default" }), "h-11 px-6 text-base")}
            >
              {t("startFree")}
              <ArrowRight aria-hidden />
            </Link>
            <Link
              href="/docs/getting-started"
              className={cn(buttonVariants({ variant: "outline" }), "h-11 px-6 text-base")}
            >
              {l("ctaDocs")}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
