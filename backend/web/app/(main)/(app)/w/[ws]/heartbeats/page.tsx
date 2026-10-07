import type { Metadata } from "next";
import { HeartbeatsPage } from "@/features/heartbeats/components/heartbeats-page";

export const metadata: Metadata = { title: "Heartbeats" };

export default function HeartbeatsRoute() {
  return <HeartbeatsPage />;
}
