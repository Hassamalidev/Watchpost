import type { Metadata } from "next";
import { OverviewView } from "@/features/monitors/components/overview";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewRoute() {
  return <OverviewView />;
}
