/*
 * A section that stays folded until someone wants it: its name and a few words about it are always
 * shown, the rest opens on a click. Screens keep the common path in view and put the rarely-used
 * and the technical behind these, so nobody has to read everything to do one thing.
 * A native <details>: keyboard and screen readers work without extra code.
 */
"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function Disclosure({
  summary,
  hint,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  bordered = true,
  className,
}: {
  summary: string;
  /* A few words shown next to the name while it is closed or open. */
  hint?: string | undefined;
  children: React.ReactNode;
  defaultOpen?: boolean;
  /* Set to control it from outside (for example to open it when a field inside has an error). */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /* A card of its own, or a plain row inside a form. */
  bordered?: boolean;
  className?: string;
}) {
  const [own, setOwn] = React.useState(defaultOpen);
  const isOpen = open ?? own;
  return (
    <details
      open={isOpen}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOwn(next);
        onOpenChange?.(next);
      }}
      className={cn("group", bordered && "rounded-lg border bg-card shadow-xs", className)}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-lg text-sm select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
          bordered ? "px-4 py-3" : "py-1",
        )}
      >
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
        <span className="font-medium">{summary}</span>
        {hint && <span className="truncate text-muted-foreground">{hint}</span>}
      </summary>
      {/* Only what is open is rendered, so a folded section loads nothing. */}
      {isOpen && (
        <div className={cn("grid gap-4", bordered ? "px-4 pb-4" : "pt-3")}>{children}</div>
      )}
    </details>
  );
}
