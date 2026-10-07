/* Header and footer shared by every public page. */
import Link from "next/link";
import { Radar } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { COMPETITORS } from "@/features/marketing/competitors";
import { LEGAL_PAGES } from "@/features/marketing/content/legal";
import { SITE_NAME } from "@/lib/site";

/* The public pages are built ahead of time, so this is the year of the build. */
const BUILD_YEAR = String(new Date().getFullYear());

export async function SiteHeader() {
  const t = await getTranslations("marketing");
  return (
    <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Radar aria-hidden className="size-5 text-brand" />
          {SITE_NAME}
        </Link>
        <nav aria-label={t("navLabel")} className="flex items-center gap-1 sm:gap-2">
          <Button asChild variant="ghost" size="sm" className="hidden lg:inline-flex">
            <Link href="/#monitors">{t("navMonitoring")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden md:inline-flex">
            <Link href="/#features">{t("navFeatures")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden lg:inline-flex">
            <Link href="/#status-pages">{t("navStatusPages")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/pricing">{t("navPricing")}</Link>
          </Button>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/docs">{t("navDocs")}</Link>
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
  );
}

function FooterColumn({
  title,
  links,
}: {
  title: string;
  links: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="grid content-start gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <ul className="grid gap-1.5">
        {links.map((link) => (
          <li key={link.href}>
            <Link href={link.href} className="hover:text-foreground hover:underline">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function SiteFooter() {
  const t = await getTranslations("marketing");
  return (
    <footer className="border-t">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 text-sm text-muted-foreground sm:grid-cols-2 sm:px-6 lg:grid-cols-[1.4fr_repeat(4,1fr)]">
        <div className="grid content-start gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold text-foreground">
            <Radar aria-hidden className="size-5 text-brand" />
            {SITE_NAME}
          </Link>
          <p className="max-w-xs">{t("footer")}</p>
        </div>
        <FooterColumn
          title={t("footerMonitoring")}
          links={[
            { href: "/docs/monitors", label: t("footerLinks.website") },
            { href: "/docs/heartbeats", label: t("footerLinks.cron") },
            { href: "/docs/alert-channels", label: t("footerLinks.channels") },
            { href: "/#status-pages", label: t("footerLinks.statusPages") },
            { href: "/#faq", label: t("footerLinks.faq") },
          ]}
        />
        <FooterColumn
          title={t("footerProduct")}
          links={[
            { href: "/pricing", label: t("navPricing") },
            { href: "/docs", label: t("navDocs") },
            { href: "/alternatives/opsgenie", label: t("footerOpsgenie") },
            { href: "/login", label: t("signIn") },
            { href: "/signup", label: t("signUp") },
          ]}
        />
        <FooterColumn
          title={t("footerCompare")}
          links={COMPETITORS.map((competitor) => ({
            href: `/compare/${competitor.slug}`,
            label: t("footerCompareWith", { name: competitor.name }),
          }))}
        />
        <FooterColumn
          title={t("footerLegal")}
          links={LEGAL_PAGES.map((page) => ({ href: `/legal/${page.slug}`, label: page.title }))}
        />
      </div>
      <p className="mx-auto max-w-6xl border-t px-4 py-6 text-sm text-muted-foreground sm:px-6">
        {t("footerRights", { year: BUILD_YEAR })}
      </p>
    </footer>
  );
}
