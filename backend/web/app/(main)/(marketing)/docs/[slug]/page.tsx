/* One docs page. */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ContentArticle } from "@/features/marketing/components/content-page";
import { DOCS_PAGES, findDocsPage } from "@/features/marketing/content/docs";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export const generateStaticParams = () => DOCS_PAGES.map((page) => ({ slug: page.slug }));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = findDocsPage((await params).slug);
  return page
    ? {
        title: page.title,
        description: page.summary,
        alternates: { canonical: `/docs/${page.slug}` },
      }
    : {};
}

export default async function DocsPage({ params }: Props) {
  const page = findDocsPage((await params).slug);
  if (!page) notFound();
  const t = await getTranslations("marketing");
  return (
    <ContentArticle
      page={page}
      before={
        <Link href="/docs" className="text-sm underline">
          {t("docsBack")}
        </Link>
      }
    />
  );
}
