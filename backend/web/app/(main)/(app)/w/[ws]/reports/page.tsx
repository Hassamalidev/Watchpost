import type { Metadata } from "next";
import { ReportsPage } from "@/features/reports/components/reports-page";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsRoute() {
  return <ReportsPage />;
}
