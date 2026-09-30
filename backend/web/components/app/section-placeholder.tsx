/* Placeholder for sidebar sections that later phases build. */
import { getTranslations } from "next-intl/server";
import type { NavItem } from "@/lib/navigation";

export async function SectionPlaceholder({ labelKey }: { labelKey: NavItem["labelKey"] }) {
  const t = await getTranslations();
  return (
    <div className="flex max-w-2xl flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">{t(`nav.${labelKey}`)}</h1>
      <p className="text-muted-foreground">
        {t("placeholder.title")}. {t("placeholder.body")}
      </p>
    </div>
  );
}
