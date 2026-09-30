/* Monitor status with icon and text; color is never the only signal (PRODUCT.md §14). */
import { useTranslations } from "next-intl";
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CirclePause,
  CircleX,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { MonitorStatus } from "@app/shared";
import { cn } from "@/lib/utils";

const STYLES: Record<MonitorStatus, { icon: LucideIcon; className: string }> = {
  up: { icon: CircleCheck, className: "text-status-up border-status-up/40 bg-status-up/10" },
  degraded: {
    icon: TriangleAlert,
    className: "text-status-degraded border-status-degraded/40 bg-status-degraded/10",
  },
  down: { icon: CircleX, className: "text-status-down border-status-down/40 bg-status-down/10" },
  maintenance: {
    icon: Wrench,
    className: "text-status-maintenance border-status-maintenance/40 bg-status-maintenance/10",
  },
  paused: {
    icon: CirclePause,
    className: "text-status-paused border-status-paused/40 bg-status-paused/10",
  },
  pending: {
    icon: CircleDashed,
    className: "text-status-pending border-status-pending/40 bg-status-pending/10",
  },
  verifying: {
    icon: CircleHelp,
    className: "text-status-degraded border-status-degraded/40 bg-status-degraded/10",
  },
};

export function StatusBadge({ status, className }: { status: MonitorStatus; className?: string }) {
  const t = useTranslations("status");
  const { icon: Icon, className: tone } = STYLES[status];
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        tone,
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {t(status)}
    </span>
  );
}
