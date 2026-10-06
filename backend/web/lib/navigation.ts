/* App sections shown in the sidebar and the command palette (PRODUCT.md §14 routes). */
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  CreditCard,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Plug,
  Wrench,
  Settings,
  Siren,
  Users,
  type LucideIcon,
} from "lucide-react";
import { roleCan, type Permission, type WorkspaceRole } from "@app/shared";
import type messages from "@/messages/en.json";

export interface NavItem {
  /* Path segment under /w/[ws]/ */
  segment: string;
  /* Key in messages/en.json under "nav" */
  labelKey: keyof (typeof messages)["nav"];
  icon: LucideIcon;
  /* What a role needs to see this section. */
  needs: Permission;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { segment: "overview", labelKey: "overview", icon: LayoutDashboard, needs: "monitor:read" },
  { segment: "monitors", labelKey: "monitors", icon: Activity, needs: "monitor:read" },
  { segment: "heartbeats", labelKey: "heartbeats", icon: HeartPulse, needs: "monitor:read" },
  { segment: "incidents", labelKey: "incidents", icon: Siren, needs: "incident:read" },
  { segment: "on-call", labelKey: "onCall", icon: CalendarClock, needs: "schedule:read" },
  { segment: "status-pages", labelKey: "statusPages", icon: Globe, needs: "monitor:read" },
  { segment: "maintenance", labelKey: "maintenance", icon: Wrench, needs: "maintenance:read" },
  { segment: "integrations", labelKey: "integrations", icon: Plug, needs: "channel:read" },
  { segment: "reports", labelKey: "reports", icon: BarChart3, needs: "monitor:read" },
  /* Your own contact methods and rules: for everyone who can be paged. */
  { segment: "notifications", labelKey: "notifications", icon: Bell, needs: "contact:manage" },
  { segment: "team", labelKey: "team", icon: Users, needs: "roster:read" },
  /* Workspace settings shape monitoring (time zone for schedules and reports), so billing skips them. */
  { segment: "settings", labelKey: "settings", icon: Settings, needs: "monitor:read" },
  { segment: "billing", labelKey: "billing", icon: CreditCard, needs: "billing:read" },
];

/* The sections a role sees. The billing role gets billing pages only (PRODUCT.md §6.11). */
export function navItemsFor(role: WorkspaceRole): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => roleCan(role, item.needs));
}

/* Where a role lands in a workspace: the overview, or billing when that is all it may see. */
export function homeSegment(role: WorkspaceRole): string {
  return navItemsFor(role)[0]?.segment ?? "billing";
}

export function workspaceHref(workspace: string, segment: string): string {
  return `/w/${encodeURIComponent(workspace)}/${segment}`;
}

/* Returns the active segment for a pathname like /w/acme/monitors/123. */
export function activeSegment(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "w" ? parts[2] : undefined;
}
