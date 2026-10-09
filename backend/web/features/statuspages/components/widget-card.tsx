/*
 * The status widget (PRODUCT.md §6.13): a small image of the page's overall state for a website's
 * footer or a README, with the HTML to paste. The image is public, like the page.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import type { StatusPageView } from "@app/shared";
import { CopyField } from "@/components/ui/copy-field";

export function WidgetCard({ page }: { page: StatusPageView }) {
  const t = useTranslations("statusPages.widget");
  /* The image is served by the app, whatever address the page itself has. */
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(globalThis.location.origin), []);
  if (!page.published) return <p className="text-sm text-muted-foreground">{t("unpublished")}</p>;
  if (origin === "") return null;
  const image = `${origin}/api/public/status-widget/${page.slug}.svg`;
  return (
    <div className="grid gap-3">
      <img src={image} alt={t("alt", { name: page.name })} height={20} className="h-5 w-auto" />
      <CopyField
        label={t("html")}
        value={`<a href="${page.url}"><img src="${image}" alt="${page.name} status" height="20"></a>`}
      />
      <CopyField label={t("markdown")} value={`[![${page.name} status](${image})](${page.url})`} />
    </div>
  );
}
