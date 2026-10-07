import type { Metadata } from "next";
import { Invitation } from "@/features/auth/components/invitation";

export const metadata: Metadata = { title: "Join a workspace", robots: { index: false } };

export default async function InvitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Invitation id={id} />;
}
