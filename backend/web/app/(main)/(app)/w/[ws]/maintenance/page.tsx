import type { Metadata } from "next";
import { MaintenancePage } from "@/features/maintenance/components/maintenance-page";

export const metadata: Metadata = { title: "Maintenance" };

export default function MaintenanceRoute() {
  return <MaintenancePage />;
}
