import type { Metadata } from "next";
import { TeamPage } from "@/features/team/components/team-page";

export const metadata: Metadata = { title: "Team" };

export default function TeamRoute() {
  return <TeamPage />;
}
