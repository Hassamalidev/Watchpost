/*
 * A public status page (PRODUCT.md §6.6). Served at /s/<slug>, and through `proxy.ts` at
 * <slug>.<STATUS_BASE_DOMAIN> and on verified custom domains. Rendered on the server from the cached
 * public API answer.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { StatusPageView } from "@/features/statuspages/components/status-page-view";
import { loadStatusPage } from "@/features/statuspages/public";

type Props = { params: Promise<{ slug: string }> };

const refOf = async (params: Props["params"]) =>
  decodeURIComponent((await params).slug).toLowerCase();

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadStatusPage(await refOf(params));
  if (data === null) return {};
  const t = await getTranslations("statusPage");
  const { page } = data;
  return {
    /* The page's own name, without ours after it. */
    title: { absolute: t("title", { name: page.name }) },
    description: page.branding.description ?? t("description", { name: page.name }),
    ...(page.branding.faviconUrl ? { icons: { icon: page.branding.faviconUrl } } : {}),
    alternates: {
      canonical: page.url,
      types: {
        "application/rss+xml": `/api/public/status/${page.slug}/rss`,
        "application/atom+xml": `/api/public/status/${page.slug}/atom`,
      },
    },
  };
}

export default async function StatusPage({ params }: Props) {
  const data = await loadStatusPage(await refOf(params));
  if (data === null) notFound();
  return <StatusPageView data={data} feedBase={`/api/public/status/${data.page.slug}`} />;
}
