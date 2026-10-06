import type { Metadata } from "next";
import { IntegrationSetup } from "@/features/integrations/components/integration-setup";

export const metadata: Metadata = { title: "Connect an integration" };

export default async function NewIntegrationRoute({
  params,
}: {
  params: Promise<{ integration: string }>;
}) {
  const { integration } = await params;
  return <IntegrationSetup integrationId={integration} />;
}
