/*
 * App shell: skip link, sidebar with primary navigation (a menu button on phones), header with ⌘K,
 * theme toggle and sign out, and the main region. The workspace gate checks the session and
 * membership before any of it renders.
 */
import type * as React from "react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Radar } from "lucide-react";
import { SidebarNav } from "@/components/app/sidebar-nav";
import { CommandPalette } from "@/components/app/command-palette";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { MobileNav, SignOutButton, WorkspaceName } from "@/components/app/shell-controls";
import { WorkspaceGate } from "@/components/app/workspace-gate";
import { workspaceHref } from "@/lib/navigation";

export async function AppShell({
  workspace,
  children,
}: {
  workspace: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("app");
  return (
    <WorkspaceGate workspaceId={workspace}>
      <div className="flex min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:shadow"
        >
          {t("skipToContent")}
        </a>
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
          <Link
            href={workspaceHref(workspace, "overview")}
            className="flex h-14 items-center gap-2 border-b px-4 font-semibold"
          >
            <Radar aria-hidden className="size-5 text-brand" />
            {t("name")}
          </Link>
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            {t("workspace")}:{" "}
            <span className="font-medium text-foreground">
              <WorkspaceName />
            </span>
          </p>
          <SidebarNav workspace={workspace} />
        </aside>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center gap-2 border-b px-4">
            <MobileNav workspace={workspace} />
            <CommandPalette workspace={workspace} />
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 p-4 focus:outline-none sm:p-6">
            {children}
          </main>
        </div>
      </div>
    </WorkspaceGate>
  );
}
