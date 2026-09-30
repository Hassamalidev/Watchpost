/* Placeholder for sidebar sections that later phases build; unknown sections 404. */
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { NAV_ITEMS } from "@/lib/navigation";

export default async function SectionPlaceholder({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  const item = NAV_ITEMS.find((i) => i.segment === section);
  if (item === undefined) notFound();
  const t = await getTranslations();
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t(`nav.${item.labelKey}`)}</h1>
      <p className="text-muted-foreground">
        {t("placeholder.title")}. {t("placeholder.body")}
      </p>
    </div>
  );
}
