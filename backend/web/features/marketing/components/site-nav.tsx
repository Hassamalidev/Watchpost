/*
 * The parts of the public header that depend on the visitor: the account links (a signed-in visitor
 * gets "Open the app" instead of sign in and sign up) and the menu that holds the page links on
 * screens too narrow to show them in the bar.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth";

/*
 * Whether the visitor has a session. Signed out is assumed until the answer arrives and when the
 * API can't be reached, so the public page never waits for it or breaks without it.
 */
function useSignedIn(): boolean {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => getSession().catch(() => null),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  return Boolean(session.data?.user);
}

export function HeaderAccount() {
  const t = useTranslations("marketing");
  const signedIn = useSignedIn();
  if (signedIn) {
    return (
      <Button asChild size="sm">
        <Link href="/w">{t("openApp")}</Link>
      </Button>
    );
  }
  return (
    <>
      <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
        <Link href="/login">{t("signIn")}</Link>
      </Button>
      <Button asChild size="sm">
        <Link href="/signup">{t("signUp")}</Link>
      </Button>
    </>
  );
}

export interface MenuLink {
  href: string;
  label: string;
}

export function MobileMenu({ links }: { links: readonly MenuLink[] }) {
  const t = useTranslations("marketing");
  const signedIn = useSignedIn();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);

  /* The header stays mounted between pages, so the menu has to close itself after a move. */
  React.useEffect(() => setOpen(false), [pathname]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const items = signedIn ? links : [...links, { href: "/login", label: t("signIn") }];

  return (
    <div className="lg:hidden">
      <Button
        ref={button}
        variant="ghost"
        size="icon"
        aria-expanded={open}
        aria-controls="site-menu"
        aria-label={t(open ? "navMenuClose" : "navMenuOpen")}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X aria-hidden /> : <Menu aria-hidden />}
      </Button>
      <ul
        id="site-menu"
        hidden={!open}
        className="absolute inset-x-0 top-16 grid gap-1 border-b bg-background px-4 py-3 shadow-lg sm:px-6"
      >
        {items.map((link) => (
          <li key={link.href}>
            {/* An in-page link doesn't change the path, so it closes the menu itself. */}
            <Link
              href={link.href}
              onClick={() => setOpen(false)}
              className="block rounded-md px-3 py-2.5 font-medium hover:bg-accent hover:text-accent-foreground"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
