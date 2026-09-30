/* Incidents page: open, resolved or all, as links so the filter lives in the URL. */
"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useWorkspace } from "@/components/app/workspace-context";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { IncidentList } from "./incident-list";

const FILTERS = ["open", "resolved", "all"] as const;

export function IncidentsIndex({ status }: { status: (typeof FILTERS)[number] }) {
  const t = useTranslations("incidents");
  const workspace = useWorkspace();
  return (
    <div className="grid max-w-4xl gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <nav aria-label={t("title")} className="flex gap-1">
        {FILTERS.map((filter) => (
          <Link
            key={filter}
            href={`${workspaceHref(workspace.id, "incidents")}?status=${filter}`}
            aria-current={filter === status ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm hover:bg-accent",
              filter === status && "bg-accent font-medium",
            )}
          >
            {t(filter)}
          </Link>
        ))}
      </nav>
      <IncidentList ws={workspace.id} {...(status === "all" ? {} : { status })} />
    </div>
  );
}
