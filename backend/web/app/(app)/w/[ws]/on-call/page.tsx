import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/app/section-placeholder";

export const metadata: Metadata = { title: "On-call" };

/* Built in a later phase (PRODUCT.md §20). */
export default async function PlaceholderPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  return <SectionPlaceholder ws={ws} labelKey="onCall" />;
}
