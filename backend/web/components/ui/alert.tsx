/* Inline notices: errors from the API, success confirmations. Text always carries the meaning. */
import * as React from "react";
import { CircleCheck, CircleX, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES = {
  error: { icon: CircleX, className: "border-status-down/40 bg-status-down/10 text-status-down" },
  success: { icon: CircleCheck, className: "border-status-up/40 bg-status-up/10 text-status-up" },
  info: { icon: Info, className: "border-border bg-muted text-foreground" },
} as const;

export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: React.ReactNode;
  className?: string;
}) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        toneClass,
        className,
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}
