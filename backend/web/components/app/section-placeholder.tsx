/*
 * Sections that later phases build: what the section will do, roughly when, and what already covers
 * the need today, so a click on the sidebar is never a dead end.
 */
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Construction } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { workspaceHref, type NavItem } from "@/lib/navigation";

type Section = Extract<NavItem["labelKey"], "onCall" | "reports" | "statusPages">;

/* Build phase (PRODUCT.md §17) and the page that helps meanwhile. */
const SECTIONS: Record<Section, { phase: number; meanwhile: string }> = {
  statusPages: { phase: 2, meanwhile: "monitors" },

  onCall: { phase: 4, meanwhile: "integrations" },
  reports: { phase: 5, meanwhile: "overview" },
};

export async function SectionPlaceholder({ labelKey, ws }: { labelKey: Section; ws: string }) {
  const t = await getTranslations();
  const { phase, meanwhile } = SECTIONS[labelKey];
  return (
    <div className="grid max-w-2xl gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t(`nav.${labelKey}`)}</h1>
      <div className="grid gap-3 rounded-lg border border-dashed p-6">
        <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Construction aria-hidden className="size-4" />
          {t("placeholder.title", { phase })}
        </p>
        <p>{t(`placeholder.sections.${labelKey}.what`)}</p>
        <p className="text-muted-foreground">{t(`placeholder.sections.${labelKey}.meanwhile`)}</p>
        <div>
          <Link
            href={workspaceHref(ws, meanwhile)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            {t(`placeholder.sections.${labelKey}.action`)}
          </Link>
        </div>
      </div>
    </div>
  );
}
