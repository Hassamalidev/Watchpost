import type { Metadata } from "next";
import { OnCallPage } from "@/features/oncall/components/on-call-page";

export const metadata: Metadata = { title: "On-call" };

export default function OnCallRoute() {
  return <OnCallPage />;
}
