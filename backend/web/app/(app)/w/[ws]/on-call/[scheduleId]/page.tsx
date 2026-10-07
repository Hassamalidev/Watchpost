import type { Metadata } from "next";
import { SchedulePage } from "@/features/oncall/components/schedule-page";

export const metadata: Metadata = { title: "Schedule" };

export default async function ScheduleRoute({
  params,
}: {
  params: Promise<{ scheduleId: string }>;
}) {
  const { scheduleId } = await params;
  return <SchedulePage scheduleId={scheduleId} />;
}
