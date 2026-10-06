/* /w: send the user to their first workspace, onboarding, or sign-in. */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { getSession } from "@/lib/auth";
import { landingPath } from "@/features/auth/components/auth-forms";

export default function WorkspacePickerPage() {
  const t = useTranslations("app");
  const router = useRouter();
  React.useEffect(() => {
    void (async () => {
      const session = await getSession().catch(() => null);
      router.replace(session ? await landingPath(null) : "/login");
    })();
  }, [router]);
  return <p className="p-6 text-muted-foreground">{t("loading")}</p>;
}
