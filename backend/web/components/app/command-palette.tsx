/* ⌘K / Ctrl+K command palette. Placeholder: navigation only; actions arrive with their features. */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useWorkspace } from "@/components/app/workspace-context";
import { navItemsFor, workspaceHref } from "@/lib/navigation";

export function isCommandShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">) {
  return event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey);
}

export function CommandPalette({ workspace }: { workspace: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const items = navItemsFor(useWorkspace().role);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCommandShortcut(event)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full max-w-xs justify-start text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        <Search aria-hidden />
        <span className="flex-1 text-left">{t("command.open")}</span>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-xs">⌘K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title={t("command.title")}>
        <CommandInput placeholder={t("command.placeholder")} />
        <CommandList>
          <CommandEmpty>{t("command.empty")}</CommandEmpty>
          <CommandGroup heading={t("command.navigate")}>
            {items.map(({ segment, labelKey, icon: Icon }) => (
              <CommandItem
                key={segment}
                value={t(`nav.${labelKey}`)}
                onSelect={() => {
                  setOpen(false);
                  router.push(workspaceHref(workspace, segment));
                }}
              >
                <Icon aria-hidden />
                {t(`nav.${labelKey}`)}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
