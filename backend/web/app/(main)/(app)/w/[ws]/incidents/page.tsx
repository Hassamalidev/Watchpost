import type { Metadata } from "next";
import { IncidentsIndex } from "@/features/incidents/components/incidents-index";

export const metadata: Metadata = { title: "Incidents" };

export default async function IncidentsRoute({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; severity?: string; monitor?: string }>;
}) {
  const { status, severity, monitor } = await searchParams;
  return (
    <IncidentsIndex
      status={status === "resolved" || status === "all" ? status : "open"}
      severity={
        severity === "critical" || severity === "high" || severity === "low" ? severity : ""
      }
      monitorId={monitor && /^[0-9a-f-]{36}$/.test(monitor) ? monitor : ""}
    />
  );
}
