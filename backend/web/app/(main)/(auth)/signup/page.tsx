import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { SignupForm } from "@/features/auth/components/auth-forms";

export const metadata: Metadata = { title: "Create an account" };

export default async function SignupPage() {
  const t = await getTranslations("auth");
  return (
    <Card>
      <CardHeader>
        <h1 className="text-xl font-semibold">{t("signupTitle")}</h1>
        <CardDescription>{t("signupIntro")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Suspense>
          <SignupForm />
        </Suspense>
      </CardContent>
    </Card>
  );
}
