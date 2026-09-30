/* Client pieces of the app shell: workspace name, sign out, and the phone navigation menu. */
"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { LogOut, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth";
import { SidebarNav } from "./sidebar-nav";
import { useWorkspace } from "./workspace-context";

export function WorkspaceName() {
  return <>{useWorkspace().name}</>;
}

export function SignOutButton() {
  const t = useTranslations("app");
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={async () => {
        await signOut().catch(() => undefined);
        queryClient.clear();
        router.replace("/login");
      }}
    >
      <LogOut aria-hidden />
      <span className="hidden sm:inline">{t("signOut")}</span>
    </Button>
  );
}

/* Below the md breakpoint the sidebar is hidden; this button opens the same navigation. */
export function MobileNav({ workspace }: { workspace: string }) {
  const t = useTranslations("app");
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  React.useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="md:hidden">
      <Button
        variant="ghost"
        size="icon"
        aria-expanded={open}
        aria-controls="mobile-nav"
        aria-label={open ? t("closeMenu") : t("menu")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X aria-hidden /> : <Menu aria-hidden />}
      </Button>
      {open && (
        <div
          id="mobile-nav"
          className="absolute inset-x-0 top-14 z-40 border-b bg-sidebar shadow-lg"
        >
          <SidebarNav workspace={workspace} />
        </div>
      )}
    </div>
  );
}
