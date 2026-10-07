import type { Metadata } from "next";
import { IntegrationsPage } from "@/features/integrations/components/integrations-page";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
