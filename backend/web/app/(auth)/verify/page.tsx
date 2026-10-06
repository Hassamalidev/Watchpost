import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MailCheck } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Check your email" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>;
}) {
  const t = await getTranslations("auth");
  const { email } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <MailCheck aria-hidden className="size-6 text-brand" />
        <h1 className="text-xl font-semibold">{t("verifyTitle")}</h1>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>{t("verifyBody", { email: email ?? "" })}</p>
        {process.env.NODE_ENV !== "production" && (
          <p className="text-muted-foreground">{t("verifyDev")}</p>
        )}
      </CardContent>
    </Card>
  );
}
