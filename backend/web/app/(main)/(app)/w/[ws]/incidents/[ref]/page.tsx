import type { Metadata } from "next";
import { IncidentDetailView } from "@/features/incidents/components/incident-detail";

export const metadata: Metadata = { title: "Incident" };

export default async function IncidentRoute({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  return <IncidentDetailView incidentRef={ref} />;
}
