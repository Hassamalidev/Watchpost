import type { Metadata } from "next";
import { MonitorDetail } from "@/features/monitors/components/monitor-detail";

export const metadata: Metadata = { title: "Monitor" };

export default async function MonitorRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MonitorDetail monitorId={id} />;
}
