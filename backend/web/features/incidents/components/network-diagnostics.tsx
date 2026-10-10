/*
 * What a failing region found when it traced the network (PRODUCT.md P8-T04): the path to the
 * target, hop by hop, and how the name resolves from the root down. Shown on the incident's
 * timeline, folded away until someone wants it. Tables, not pictures: the content is the numbers.
 */
"use client";

import { useTranslations } from "next-intl";
import { networkDiagnosticsSchema } from "@app/shared";

export function NetworkDiagnosticsEvent({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations("incidents.diagnostics");
  const parsed = networkDiagnosticsSchema.safeParse(data);
  if (!parsed.success) return null;
  const { host, address, traceroute, dnsTrace, notes } = parsed.data;
  const region = typeof data.region === "string" ? data.region : "";
  const last = dnsTrace?.steps.at(-1);
  return (
    <details className="mt-1 rounded-md border p-2">
      <summary className="cursor-pointer text-sm">
        {t("summary", { region, host })}
        {traceroute !== null && (
          <span className="text-muted-foreground">
            {" · "}
            {traceroute.reached ? t("reached", { hops: traceroute.hops.length }) : t("notReached")}
          </span>
        )}
        {last !== undefined && (
          <span className="text-muted-foreground">
            {" · "}
            {t(`dnsOutcome.${last.outcome}`)}
          </span>
        )}
      </summary>
      <div className="mt-2 grid gap-3 text-xs">
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        {traceroute !== null && (
          <table className="w-full border-collapse text-left">
            <caption className="pb-1 text-left font-medium">
              {t("pathTo", { address: address ?? host })}
            </caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="w-10 py-1 font-normal">
                  {t("hop")}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {t("address")}
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  {t("time")}
                </th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {traceroute.hops.map((hop) => (
                <tr key={hop.hop} className="border-b last:border-0">
                  <td className="py-1">{hop.hop}</td>
                  <td className="py-1">{hop.ip ?? t("noReply")}</td>
                  <td className="py-1 text-right">
                    {hop.rttMs === null ? "" : t("ms", { ms: hop.rttMs })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {dnsTrace !== null && (
          <table className="w-full border-collapse text-left">
            <caption className="pb-1 text-left font-medium">
              {t("dnsFor", { name: dnsTrace.name })}
            </caption>
            <thead>
              <tr className="border-b text-muted-foreground">
                <th scope="col" className="py-1 font-normal">
                  {t("zone")}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {t("server")}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {t("said")}
                </th>
              </tr>
            </thead>
            <tbody>
              {dnsTrace.steps.map((step) => (
                <tr
                  key={`${step.zone}-${step.server}`}
                  className="border-b align-top last:border-0"
                >
                  <td className="py-1 pr-2 font-mono">{step.zone}</td>
                  <td className="py-1 pr-2 font-mono">{step.server}</td>
                  <td className="py-1">
                    <span className="font-medium">{t(`dnsOutcome.${step.outcome}`)}</span>
                    {": "}
                    {step.detail} ({t("ms", { ms: step.ms })})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
