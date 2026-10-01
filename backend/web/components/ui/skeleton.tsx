/*
 * Loading placeholders shaped like the content that is coming, so the page doesn't jump when it
 * arrives. Screen readers hear the label once instead of the bars.
 */
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

export function Loading({ rows = 3, className }: { rows?: number; className?: string }) {
  const t = useTranslations("app");
  return (
    <div role="status" className={cn("grid gap-2", className)}>
      <span className="sr-only">{t("loading")}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-12", i === rows - 1 && rows > 1 && "w-2/3")} />
      ))}
    </div>
  );
}
