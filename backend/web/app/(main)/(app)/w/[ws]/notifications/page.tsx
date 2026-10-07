import type { Metadata } from "next";
import { NotificationsPage } from "@/features/notifications/components/notifications-page";

export const metadata: Metadata = { title: "My notifications" };

export default function NotificationsRoute() {
  return <NotificationsPage />;
}
