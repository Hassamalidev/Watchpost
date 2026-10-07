import type { Metadata } from "next";
import { StatusPageEditor } from "@/features/statuspages/components/status-page-editor";

export const metadata: Metadata = { title: "Status page" };

export default async function StatusPageRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StatusPageEditor id={id} />;
}
