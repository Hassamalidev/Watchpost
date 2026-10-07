/* Legal pages. Drafts until the owner has reviewed them (Open decision #15), and labeled as such. */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert } from "@/components/ui/alert";
import { ContentArticle } from "@/features/marketing/components/content-page";
import { LEGAL_LAST_UPDATED, LEGAL_PAGES, findLegalPage } from "@/features/marketing/content/legal";

type Props = { params: Promise<{ doc: string }> };

export const dynamicParams = false;

export const generateStaticParams = () => LEGAL_PAGES.map((page) => ({ doc: page.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = findLegalPage((await params).doc);
  /* Drafts stay out of search results until they are reviewed. */
  return page ? { title: page.title, robots: { index: false } } : {};
}

export default async function LegalPage({ params }: Props) {
  const page = findLegalPage((await params).doc);
  if (!page) notFound();
  const t = await getTranslations("marketing");
  return (
    <ContentArticle
      page={page}
      before={<Alert>{t("legalDraft")}</Alert>}
      after={
        <p className="text-sm text-muted-foreground">
          {t("legalUpdated", { date: LEGAL_LAST_UPDATED })}
        </p>
      }
    />
  );
}
