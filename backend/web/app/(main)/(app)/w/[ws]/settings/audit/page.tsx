import type { Metadata } from "next";
import { AuditLog } from "@/features/settings/components/audit-log";

export const metadata: Metadata = { title: "Audit log" };

export default function AuditLogRoute() {
  return <AuditLog />;
}
