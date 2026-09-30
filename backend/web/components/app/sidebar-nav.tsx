/* Workspace sidebar links; the current section gets aria-current="page". */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { NAV_ITEMS, activeSegment, workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function SidebarNav({ workspace }: { workspace: string }) {
  const t = useTranslations();
  const active = activeSegment(usePathname());

  return (
    <nav aria-label={t("app.primaryNav")} className="flex flex-col gap-0.5 p-2">
      {NAV_ITEMS.map(({ segment, labelKey, icon: Icon }) => {
        const isActive = segment === active;
        return (
          <Link
            key={segment}
            href={workspaceHref(workspace, segment)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-accent focus-visible:outline-2",
              isActive && "bg-accent font-medium text-accent-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
            {t(`nav.${labelKey}`)}
          </Link>
        );
      })}
    </nav>
  );
}
