/*
 * The integration gallery: search, category filter and one card per integration, each linking to its
 * setup page. Integrations this server can't deliver to yet (the Slack app or Telegram bot without
 * credentials) stay visible but say so, with the alternative that works today.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, Search } from "lucide-react";
import {
  CHANNEL_CAPABILITIES,
  INTEGRATION_CATEGORIES,
  type ChannelType,
  type IntegrationDefinition,
} from "@app/shared";
import { EmptyState } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { searchIntegrations, type CategoryFilter } from "../catalog";
import { IntegrationTile } from "./parts";

const FILTERS: readonly CategoryFilter[] = ["all", ...INTEGRATION_CATEGORIES];

function IntegrationCard({
  ws,
  integration,
  available,
}: {
  ws: string;
  integration: IntegrationDefinition;
  available: boolean;
}) {
  const t = useTranslations("integrations");
  const { followUps } = CHANNEL_CAPABILITIES[integration.type];
  const footer = !available
    ? t("unavailable")
    : followUps === "separate"
      ? null
      : t(`followUps.${followUps}`);
  return (
    <li>
      <Link
        href={workspaceHref(ws, `integrations/new/${integration.id}`)}
        className={cn(
          "group flex h-full flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs transition-colors hover:border-foreground/30 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          !available && "border-dashed",
        )}
      >
        <div className="flex items-center gap-3">
          <IntegrationTile id={integration.id} />
          <div className="min-w-0">
            <h3 className="truncate font-medium">{integration.name}</h3>
            <p className="text-xs text-muted-foreground">
              {t(`categories.${integration.category}`)}
            </p>
          </div>
          <ArrowRight
            aria-hidden
            className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </div>
        <p className="text-sm text-muted-foreground">{t(`catalog.${integration.id}.summary`)}</p>
        {footer && <p className="mt-auto text-xs font-medium">{footer}</p>}
      </Link>
    </li>
  );
}

export function IntegrationGallery({
  ws,
  availability,
}: {
  ws: string;
  /* Types this server can deliver to; undefined while loading (everything shows as available). */
  availability: ReadonlyMap<ChannelType, boolean> | undefined;
}) {
  const t = useTranslations("integrations");
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<CategoryFilter>("all");
  const results = searchIntegrations(
    query,
    category,
    (i) => `${t(`categories.${i.category}`)} ${t(`catalog.${i.id}.summary`)}`,
  );

  return (
    <section className="grid gap-3" aria-labelledby="gallery-heading">
      <h2 id="gallery-heading" className="text-base font-semibold">
        {t("gallery")}
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={t("search")}
            placeholder={t("searchPlaceholder")}
            value={query}
            className="pl-8"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div role="group" aria-label={t("categoryFilter")} className="flex flex-wrap gap-1.5">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              aria-pressed={category === filter}
              onClick={() => setCategory(filter)}
              className={cn(
                "h-8 rounded-full border px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                category === filter
                  ? "border-foreground bg-foreground text-background"
                  : "bg-background hover:bg-accent",
              )}
            >
              {t(`categories.${filter}`)}
            </button>
          ))}
        </div>
      </div>
      <p aria-live="polite" className="text-xs text-muted-foreground">
        {results.length > 0 && t("resultCount", { count: results.length })}
      </p>
      {results.length === 0 ? (
        <EmptyState title={t("noResults", { query: query.trim() })}>
          <p>{t("noResultsHint")}</p>
          <p className="mt-2">
            <Link href={workspaceHref(ws, "integrations/new/webhook")} className="underline">
              {t("noResultsAction")}
            </Link>
          </p>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((integration) => (
            <IntegrationCard
              key={integration.id}
              ws={ws}
              integration={integration}
              available={availability?.get(integration.type) ?? true}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
