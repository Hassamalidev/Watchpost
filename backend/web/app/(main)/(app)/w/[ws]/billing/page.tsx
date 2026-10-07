import type { Metadata } from "next";
import { BillingPage } from "@/features/billing/components/billing-page";

export const metadata: Metadata = { title: "Billing" };

export default function BillingRoute() {
  return <BillingPage />;
}
