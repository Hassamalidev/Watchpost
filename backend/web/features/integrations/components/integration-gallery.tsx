/*
 * The integration gallery: search, category filter and one card per integration, each linking to its
 * setup page. Integrations this server can't deliver to yet (the Slack app or Telegram bot without
 * credentials) stay visible but say so, with the alternative that works today.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowRight, CircleCheck, Search } from "lucide-react";
import {
  INTEGRATION_CATEGORIES,
  type ChannelType,
  type IntegrationDefinition,
  type IntegrationId,
} from "@app/shared";
import { EmptyState } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, errorMessage, wsPath } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { workspaceHref } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { searchIntegrations, type CategoryFilter } from "../catalog";
import { IntegrationTile } from "./parts";

const FILTERS: readonly CategoryFilter[] = ["all", ...INTEGRATION_CATEGORIES];
/* What most teams connect first; shown before the full list. */
const POPULAR: readonly IntegrationId[] = [
  "email",
  "slack",
  "teams",
  "discord",
  "telegram",
  "webhook",
];

function IntegrationCard({
  ws,
  integration,
  available,
  connected,
}: {
  ws: string;
  integration: IntegrationDefinition;
  available: boolean;
  /* How many channels of this kind the workspace already has. */
  connected: number;
}) {
  const t = useTranslations("integrations");
  const footer = available ? null : t("unavailable");
  return (
    <li>
      <Link
        href={workspaceHref(ws, `integrations/new/${integration.id}`)}
        className={cn(
          "group flex h-full flex-col gap-2 rounded-lg border bg-card p-4 shadow-xs transition-colors hover:border-foreground/30 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          !available && "border-dashed",
        )}
      >
        <div className="flex items-center gap-3">
          <IntegrationTile id={integration.id} />
          <div className="min-w-0">
            <h3 className="truncate font-medium">{integration.name}</h3>
            {/* Read by screen readers and search; one line of text per card is enough to see. */}
            <p className="sr-only">{t(`categories.${integration.category}`)}</p>
            <p className="text-sm text-muted-foreground">
              {t(`catalog.${integration.id}.summary`)}
            </p>
          </div>
          <ArrowRight
            aria-hidden
            className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </div>
        {(footer !== null || connected > 0) && (
          <p className="mt-auto flex flex-wrap items-center justify-between gap-2 text-xs font-medium">
            <span>{footer}</span>
            {connected > 0 && (
              <span className="inline-flex items-center gap-1 text-status-up">
                <CircleCheck aria-hidden className="size-3.5" />
                {t("connectedMark", { count: connected })}
              </span>
            )}
          </p>
        )}
      </Link>
    </li>
  );
}

/* "We don't have it" becomes a line in our request log, which orders what we build next. */
function RequestIntegration({ ws, name }: { ws: string; name: string }) {
  const t = useTranslations("integrations");
  /* What was asked for and how it went; the thanks belongs to that name, not to what is typed next. */
  const [sent, setSent] = React.useState<{ name: string; problem?: string } | "sending" | null>(
    null,
  );
  if (name.length < 2 || name.length > 80) return null;
  async function send() {
    setSent("sending");
    try {
      await api<{ recorded: boolean }>(wsPath(ws, "/integration-requests"), {
        method: "POST",
        body: { name },
      });
      setSent({ name });
    } catch (err) {
      setSent({ name, problem: errorMessage(err) });
    }
  }
  const done = sent !== null && sent !== "sending" && sent.name === name ? sent : undefined;
  return (
    <p className="mt-3" role="status">
      {done !== undefined && done.problem === undefined ? (
        t("requestThanks", { name })
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={sent === "sending"}
          onClick={() => void send()}
        >
          {t("requestAction", { name })}
        </Button>
      )}
      {done?.problem !== undefined && <span className="ml-2 text-sm">{done.problem}</span>}
    </p>
  );
}

export function IntegrationGallery({
  ws,
  availability,
  connected,
}: {
  ws: string;
  /* Types this server can deliver to; undefined while loading (everything shows as available). */
  availability: ReadonlyMap<ChannelType, boolean> | undefined;
  /* Channels the workspace already has, per gallery entry. */
  connected?: ReadonlyMap<IntegrationId, number>;
}) {
  const t = useTranslations("integrations");
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<CategoryFilter>("all");
  const [showAll, setShowAll] = React.useState(false);
  const found = searchIntegrations(
    query,
    category,
    (i) => `${t(`categories.${i.category}`)} ${t(`catalog.${i.id}.summary`)}`,
  );
  /*
   * Twenty-six cards are a lot to read for someone who wants "email" or "Slack". Until they search,
   * filter or ask for everything, the gallery shows the handful most people pick.
   */
  const browsing = query.trim() === "" && category === "all" && !showAll;
  const results = browsing ? found.filter((i) => POPULAR.includes(i.id)) : found;

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3" aria-labelledby="gallery-heading">
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
        {browsing
          ? t("popular")
          : results.length > 0 && t("resultCount", { count: results.length })}
      </p>
      {results.length === 0 ? (
        <EmptyState title={t("noResults", { query: query.trim() })}>
          <p>{t("noResultsHint")}</p>
          <p className="mt-2">
            <Link href={workspaceHref(ws, "integrations/new/webhook")} className="underline">
              {t("noResultsAction")}
            </Link>
          </p>
          <RequestIntegration ws={ws} name={query.trim()} />
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((integration) => (
            <IntegrationCard
              key={integration.id}
              ws={ws}
              integration={integration}
              available={availability?.get(integration.type) ?? true}
              connected={connected?.get(integration.id) ?? 0}
            />
          ))}
        </ul>
      )}
      {browsing && (
        <div>
          <Button variant="outline" size="sm" onClick={() => setShowAll(true)}>
            {t("showAll", { count: found.length })}
          </Button>
        </div>
      )}
    </section>
  );
}
