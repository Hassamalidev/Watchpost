/* Marketing landing placeholder; the real site is P3-T07. */
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/app/theme-toggle";

export default async function HomePage() {
  const t = await getTranslations("marketing");
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-6">
      <header className="flex h-16 items-center justify-between">
        <span className="font-semibold">Watchpost</span>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 flex-col justify-center gap-6 pb-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance">{t("hero")}</h1>
        <p className="text-lg text-muted-foreground text-pretty">{t("subhead")}</p>
        <div>
          <Button asChild>
            <Link href="/w">{t("openApp")}</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
