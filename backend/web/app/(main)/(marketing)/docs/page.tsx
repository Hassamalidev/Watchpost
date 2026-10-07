/* Docs index. */
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DOCS_PAGES } from "@/features/marketing/content/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Guides for UptimeWatch: getting started, monitors, heartbeats for cron jobs, alert channels, deploy markers and moving from Opsgenie.",
  alternates: { canonical: "/docs" },
};

export default async function DocsIndexPage() {
  const t = await getTranslations("marketing");
  return (
    <div className="mx-auto grid max-w-3xl gap-8 px-4 py-12 sm:px-6">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t("docsTitle")}</h1>
        <p className="text-muted-foreground">{t("docsIntro")}</p>
      </header>
      <ul className="grid gap-3">
        {DOCS_PAGES.map((page) => (
          <li key={page.slug} className="rounded-lg border bg-card p-4">
            <Link href={`/docs/${page.slug}`} className="font-semibold underline">
              {page.title}
            </Link>
            <p className="mt-1 text-sm text-muted-foreground">{page.summary}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
