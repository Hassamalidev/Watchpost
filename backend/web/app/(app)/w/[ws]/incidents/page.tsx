import type { Metadata } from "next";
import { IncidentsIndex } from "@/features/incidents/components/incidents-index";

export const metadata: Metadata = { title: "Incidents" };

export default async function IncidentsRoute({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  return <IncidentsIndex status={status === "resolved" || status === "all" ? status : "open"} />;
}
