import type { Metadata } from "next";
import { ActionLink } from "@/features/actions/action-link";

export const metadata: Metadata = { title: "Incident action", robots: { index: false } };

export default async function ActionLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="flex min-h-dvh items-start justify-center p-4 sm:items-center">
      <ActionLink token={token} />
    </main>
  );
}
