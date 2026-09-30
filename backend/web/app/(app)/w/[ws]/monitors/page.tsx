import type { Metadata } from "next";
import { MonitorsIndex } from "@/features/monitors/components/overview";

export const metadata: Metadata = { title: "Monitors" };

export default function MonitorsRoute() {
  return <MonitorsIndex />;
}
