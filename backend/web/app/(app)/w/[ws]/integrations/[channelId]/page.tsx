import type { Metadata } from "next";
import { ChannelView } from "@/features/integrations/components/channel-view";

export const metadata: Metadata = { title: "Integration" };

export default async function ChannelRoute({ params }: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await params;
  return <ChannelView channelId={channelId} />;
}
