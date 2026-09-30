import type { Metadata } from "next";
import { SectionPlaceholder } from "@/components/app/section-placeholder";

export const metadata: Metadata = { title: "On-call" };

/* Built in a later phase (PRODUCT.md §20). */
export default function PlaceholderPage() {
  return <SectionPlaceholder labelKey="onCall" />;
}
