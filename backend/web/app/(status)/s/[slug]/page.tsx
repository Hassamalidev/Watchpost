/*
 * A public status page (PRODUCT.md §6.6). Served at /s/<slug>, and through `proxy.ts` at
 * <slug>.<STATUS_BASE_DOMAIN> and on verified custom domains. Rendered on the server from the cached
 * public API answer. A private page is asked for again for the visitor in front of us, and shows
 * its lock when they may not see it.
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { StatusPageLocked } from "@/features/statuspages/components/status-page-locked";
import {
  SUBSCRIBE_NOTICES,
  StatusPageView,
} from "@/features/statuspages/components/status-page-view";
import {
  isLocked,
  loadStatusPage,
  loadStatusPageAs,
  visitorIp,
} from "@/features/statuspages/public";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ subscribe?: string | string[]; unlock?: string | string[] }>;
};

const refOf = async (params: Props["params"]) =>
  decodeURIComponent((await params).slug).toLowerCase();

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await loadStatusPage(await refOf(params));
  if (data === null) return {};
  const t = await getTranslations("statusPage");
  const { page } = data;
  const icons = page.branding.faviconUrl ? { icons: { icon: page.branding.faviconUrl } } : {};
  /* A private page tells search engines and link previews its name and nothing else. */
  if (isLocked(data)) {
    return { title: { absolute: page.name }, robots: { index: false, follow: false }, ...icons };
  }
  return {
    /* The page's own name, without ours after it. */
    title: { absolute: t("title", { name: page.name }) },
    description: page.branding.description ?? t("description", { name: page.name }),
    ...icons,
    alternates: {
      canonical: page.url,
      types: {
        "application/rss+xml": `/api/public/status/${page.slug}/rss`,
        "application/atom+xml": `/api/public/status/${page.slug}/atom`,
      },
    },
  };
}

export default async function StatusPage({ params, searchParams }: Props) {
  const ref = await refOf(params);
  let data = await loadStatusPage(ref);
  if (data !== null && isLocked(data)) {
    const sent = await headers();
    data = await loadStatusPageAs(ref, {
      ip: visitorIp((name) => sent.get(name)),
      cookie: sent.get("cookie") ?? undefined,
    });
  }
  if (data === null) notFound();
  const { subscribe, unlock } = await searchParams;
  const base = `/api/public/status/${data.page.slug}`;
  if (isLocked(data)) {
    return (
      <StatusPageLocked locked={data} unlockAction={`${base}/unlock`} wrong={unlock === "wrong"} />
    );
  }
  /* The API sends a visitor back here after the subscribe form and the links in its emails. */
  const notice = SUBSCRIBE_NOTICES.find((value) => value === subscribe);
  return (
    <StatusPageView
      data={data}
      feedBase={base}
      subscribeAction={`${base}/subscribers`}
      notice={notice}
    />
  );
}
