/* Cycles light → dark → system. The label names the next state for screen readers. */
"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const ORDER = ["light", "dark", "system"] as const;
type ThemeChoice = (typeof ORDER)[number];

function nextTheme(current: string | undefined): ThemeChoice {
  const index = ORDER.indexOf((current ?? "system") as ThemeChoice);
  return ORDER[(index + 1) % ORDER.length] ?? "light";
}

export function ThemeToggle() {
  const t = useTranslations("theme");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const current = (mounted ? theme : "system") as ThemeChoice;
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`${t("toggle")}: ${t(current)}`}
      title={`${t("toggle")}: ${t(current)}`}
      onClick={() => setTheme(nextTheme(current))}
    >
      <Icon aria-hidden />
    </Button>
  );
}
