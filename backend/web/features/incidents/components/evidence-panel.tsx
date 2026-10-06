/*
 * What the failing checks saw when the incident opened, per failing region: status, where the time
 * went, the response headers we keep and the start of the body. Stored privately for 30 days; after
 * that the panel says so.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { TIMING_PHASES, formatMs, type EvidenceBundle } from "@app/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { incidentsApi } from "../api";

function Waterfall({ timings }: { timings: NonNullable<EvidenceBundle["timings"]> }) {
  const t = useTranslations("incidents.evidence");
  const phases = TIMING_PHASES.flatMap((phase) => {
    const ms = timings[phase];
    return typeof ms === "number" ? [{ phase, ms }] : [];
  });
  if (phases.length === 0) return null;
  const total = Math.max(timings.total, 1);
  return (
    <div className="grid gap-1.5">
      <p className="text-muted-foreground">{t("timings", { total: formatMs(timings.total) })}</p>
      <ul className="grid gap-1">
        {phases.map(({ phase, ms }) => (
          <li key={phase} className="grid grid-cols-[9rem_1fr_4rem] items-center gap-2 text-xs">
            <span>{t(`phase.${phase}`)}</span>
            <span className="h-2 rounded-sm bg-muted" aria-hidden>
              <span
                className="block h-2 rounded-sm bg-brand"
                style={{ width: `${Math.max(2, Math.min(100, (ms / total) * 100))}%` }}
              />
            </span>
            <span className="text-right font-mono">{formatMs(ms)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Bundle({ bundle }: { bundle: EvidenceBundle }) {
  const t = useTranslations("incidents.evidence");
  const headers = Object.entries(bundle.headers);
  return (
    <div className="grid gap-3">
      <p className="font-medium">
        {bundle.httpStatus === null
          ? t("noResponse")
          : t("answered", { status: bundle.httpStatus })}
        {bundle.errorCode && (
          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
            {bundle.errorCode}
          </span>
        )}
      </p>
      {bundle.message && <p className="text-muted-foreground">{bundle.message}</p>}
      {bundle.ip && <p className="text-xs text-muted-foreground">{t("ip", { ip: bundle.ip })}</p>}
      {bundle.timings && <Waterfall timings={bundle.timings} />}
      {headers.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground">{t("headers")}</p>
          <dl className="grid gap-x-3 gap-y-1 font-mono text-xs sm:grid-cols-[12rem_1fr]">
            {headers.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {bundle.bodySnippet !== null && bundle.bodySnippet !== "" && (
        <div className="grid gap-1.5">
          <p className="text-muted-foreground">
            {bundle.bodyTruncated ? t("bodyStart") : t("body")}
          </p>
          <pre
            tabIndex={0}
            className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap"
          >
            {bundle.bodySnippet}
          </pre>
        </div>
      )}
    </div>
  );
}

export function EvidencePanel({ ws, incidentRef }: { ws: string; incidentRef: string }) {
  const t = useTranslations("incidents.evidence");
  const evidence = useQuery({
    queryKey: ["incident-evidence", ws, incidentRef],
    queryFn: async () => (await incidentsApi.evidence(ws, incidentRef)).data,
    /* Evidence is written once, when the incident opens. */
    staleTime: 5 * 60_000,
  });
  if (evidence.data === undefined || evidence.data.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 text-sm">
        {evidence.data.map((item) => (
          <section key={item.region} className="grid gap-2" aria-label={item.region}>
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
              {item.region}
              <span className="text-xs font-normal text-muted-foreground">
                {formatDateTime(item.checkedAt)}
              </span>
            </h3>
            {item.available ? (
              <Bundle bundle={item.bundle} />
            ) : (
              <p className="text-muted-foreground">{t("expired")}</p>
            )}
          </section>
        ))}
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </CardContent>
    </Card>
  );
}
