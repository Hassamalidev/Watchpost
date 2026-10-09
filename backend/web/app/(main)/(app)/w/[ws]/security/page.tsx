import type { Metadata } from "next";
import { SecurityPage } from "@/features/security/components/security-page";

export const metadata: Metadata = { title: "Security" };

export default function SecurityRoute() {
  return <SecurityPage />;
}
