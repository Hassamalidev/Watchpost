import type { Metadata } from "next";
import { StatusPagesList } from "@/features/statuspages/components/status-pages-list";

export const metadata: Metadata = { title: "Status pages" };

export default function StatusPagesRoute() {
  return <StatusPagesList />;
}
