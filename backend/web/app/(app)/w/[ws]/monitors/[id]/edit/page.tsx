import type { Metadata } from "next";
import { EditMonitorView } from "@/features/monitors/components/overview";

export const metadata: Metadata = { title: "Edit monitor" };

export default async function EditMonitorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditMonitorView monitorId={id} />;
}
