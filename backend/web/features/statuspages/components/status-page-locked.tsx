/*
 * What a visitor without access sees of a private status page (PRODUCT.md §6.6): whose page it is
 * and, for a password-protected one, the form that opens it. A plain HTML form: no JavaScript.
 */
import type * as React from "react";
import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import type { PublicStatusLocked } from "@app/shared";

export function StatusPageLocked({
  locked,
  unlockAction,
  wrong = false,
  wait = false,
}: {
  locked: PublicStatusLocked;
  /* Where the password form posts. */
  unlockAction: string;
  /* The password just entered was not right. */
  wrong?: boolean;
  /* Too many tries from this visitor's network for now. */
  wait?: boolean;
}): React.ReactElement {
  const t = useTranslations("statusPage.locked");
  const { page } = locked;
  const accent = page.branding.accentColor;
  return (
    <div
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10"
      style={accent ? ({ "--page-accent": accent } as React.CSSProperties) : undefined}
    >
      <header className="flex items-center gap-3">
        {page.branding.logoUrl && (
          /* The customer's own logo, from their address: not an image we can optimize. */
          <img src={page.branding.logoUrl} alt="" className="h-8 w-auto" />
        )}
        <h1 className="text-2xl font-semibold tracking-tight">{page.name}</h1>
      </header>
      <p className="flex items-start gap-2 text-sm">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{locked.locked === "password" ? t("password") : t("network")}</span>
      </p>
      {locked.locked === "password" && (
        <form method="post" action={unlockAction} className="grid gap-3">
          {(wrong || wait) && (
            <p role="alert" className="rounded-md border border-status-down p-3 text-sm">
              {wait ? t("wait") : t("wrong")}
            </p>
          )}
          <div className="grid gap-1.5">
            <label htmlFor="status-page-password" className="text-sm font-medium">
              {t("label")}
            </label>
            <input
              id="status-page-password"
              name="password"
              type="password"
              required
              maxLength={200}
              autoComplete="current-password"
              aria-invalid={wrong || undefined}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
          </div>
          <div>
            <button
              type="submit"
              className="inline-flex h-10 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {t("open")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
