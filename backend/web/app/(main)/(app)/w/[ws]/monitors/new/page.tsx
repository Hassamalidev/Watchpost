import type { Metadata } from "next";
import { NewMonitorView } from "@/features/monitors/components/overview";

export const metadata: Metadata = { title: "New monitor" };

export default function NewMonitorRoute() {
  return <NewMonitorView />;
}
