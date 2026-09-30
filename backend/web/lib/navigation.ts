/* App sections shown in the sidebar and the command palette (PRODUCT.md §14 routes). */
import {
  Activity,
  BarChart3,
  CalendarClock,
  CreditCard,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Plug,
  Settings,
  Siren,
  Users,
  type LucideIcon,
} from "lucide-react";
import type messages from "@/messages/en.json";

export interface NavItem {
  /* Path segment under /w/[ws]/ */
  segment: string;
  /* Key in messages/en.json under "nav" */
  labelKey: keyof (typeof messages)["nav"];
  icon: LucideIcon;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "overview", labelKey: "overview", icon: LayoutDashboard },
  { segment: "monitors", labelKey: "monitors", icon: Activity },
  { segment: "heartbeats", labelKey: "heartbeats", icon: HeartPulse },
  { segment: "incidents", labelKey: "incidents", icon: Siren },
  { segment: "on-call", labelKey: "onCall", icon: CalendarClock },
  { segment: "status-pages", labelKey: "statusPages", icon: Globe },
  { segment: "integrations", labelKey: "integrations", icon: Plug },
  { segment: "reports", labelKey: "reports", icon: BarChart3 },
  { segment: "team", labelKey: "team", icon: Users },
  { segment: "settings", labelKey: "settings", icon: Settings },
  { segment: "billing", labelKey: "billing", icon: CreditCard },
];

export function workspaceHref(workspace: string, segment: string): string {
  return `/w/${encodeURIComponent(workspace)}/${segment}`;
}

/* Returns the active segment for a pathname like /w/acme/monitors/123. */
export function activeSegment(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "w" ? parts[2] : undefined;
}
