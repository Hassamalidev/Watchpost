import type { Metadata } from "next";
import { ImportPage } from "@/features/imports/components/import-page";

export const metadata: Metadata = { title: "Import" };

export default function ImportRoute() {
  return <ImportPage />;
}
