/* Sign-in and sign-up forms (Better Auth email + password). */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError, errorMessage } from "@/lib/api";
import { listWorkspaces, signIn, signUp, twoFactor } from "@/lib/auth";
import { SELECTED_PLAN_STORAGE_KEY, isMarketingPlanKey } from "@/features/marketing/plans";

/* Where a signed-in user goes: back to `next`, their first workspace, or onboarding. */
export async function landingPath(next: string | null): Promise<string> {
  if (next?.startsWith("/w/") || next?.startsWith("/invite/")) return next;
  const workspaces = await listWorkspaces();
  return workspaces[0] ? `/w/${workspaces[0].id}/overview` : "/onboarding";
}

/* The second step of signing in: a code from the authenticator app, or one of the backup codes. */
function TwoFactorStep({ onDone }: { onDone: () => Promise<void> }) {
  const t = useTranslations("auth");
  const [code, setCode] = React.useState("");
  const [backup, setBackup] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      className="grid gap-4"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        setBusy(true);
        try {
          await (backup ? twoFactor.verifyBackupCode(code.trim()) : twoFactor.verify(code.trim()));
          await onDone();
        } catch {
          setError(t("twoFactor.wrong"));
          setBusy(false);
        }
      }}
    >
      {error && <Alert tone="error">{error}</Alert>}
      <Field
        label={backup ? t("twoFactor.backupLabel") : t("twoFactor.codeLabel")}
        htmlFor="login-code"
        hint={backup ? t("twoFactor.backupHint") : t("twoFactor.codeHint")}
      >
        <Input
          id="login-code"
          autoFocus
          autoComplete="one-time-code"
          inputMode={backup ? "text" : "numeric"}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </Field>
      <Button type="submit" disabled={busy || code.trim() === ""}>
        {busy ? t("signingIn") : t("twoFactor.submit")}
      </Button>
      <button
        type="button"
        className="text-center text-sm underline"
        onClick={() => {
          setBackup(!backup);
          setCode("");
          setError(null);
        }}
      >
        {backup ? t("twoFactor.useApp") : t("twoFactor.useBackup")}
      </button>
    </form>
  );
}

export function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [error, setError] = React.useState<string | null>(null);
  /* The password was right and the account has two-factor sign-in: the code comes next. */
  const [needsCode, setNeedsCode] = React.useState(false);
  const schema = z.object({
    email: z.email(t("invalidEmail")),
    password: z.string().min(1, t("shortPassword")),
  });
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      const result = await signIn(values);
      if (result?.twoFactorRedirect === true) {
        setNeedsCode(true);
        return;
      }
      router.replace(await landingPath(next));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? t("unverified") : errorMessage(err));
    }
  });

  if (needsCode) {
    return <TwoFactorStep onDone={async () => router.replace(await landingPath(next))} />;
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label={t("email")} htmlFor="login-email" error={form.formState.errors.email?.message}>
        <Input id="login-email" type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field
        label={t("password")}
        htmlFor="login-password"
        error={form.formState.errors.password?.message}
      >
        <Input
          id="login-password"
          type="password"
          autoComplete="current-password"
          {...form.register("password")}
        />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t("signingIn") : t("signIn")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("noAccount")}{" "}
        <Link
          href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
          className="text-foreground underline"
        >
          {t("createOne")}
        </Link>
      </p>
    </form>
  );
}

export function SignupForm() {
  const t = useTranslations("auth");
  const tPlans = useTranslations("marketing.plans");
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const planParam = params.get("plan");
  /* A paid plan picked on the landing page; billing reads it back after sign-up. */
  const plan = isMarketingPlanKey(planParam) && planParam !== "free" ? planParam : null;
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!plan) return;
    try {
      window.localStorage.setItem(
        SELECTED_PLAN_STORAGE_KEY,
        JSON.stringify({
          plan,
          billing: params.get("billing") === "annual" ? "annual" : "monthly",
        }),
      );
    } catch {
      /* Storage can be blocked; the plan can still be picked on the billing page. */
    }
  }, [plan, params]);
  const schema = z.object({
    name: z.string().trim().min(1, t("nameRequired")),
    email: z.email(t("invalidEmail")),
    password: z.string().min(8, t("shortPassword")),
  });
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await signUp(values, next?.startsWith("/invite/") ? next : undefined);
      router.push(`/verify?email=${encodeURIComponent(values.email)}`);
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      {plan && (
        <Alert>
          {t("planSelected", { plan: tPlans(`${plan}.name`) })}{" "}
          <Link href="/#pricing" className="underline">
            {t("changePlan")}
          </Link>
        </Alert>
      )}
      <Field label={t("name")} htmlFor="signup-name" error={form.formState.errors.name?.message}>
        <Input id="signup-name" autoComplete="name" {...form.register("name")} />
      </Field>
      <Field label={t("email")} htmlFor="signup-email" error={form.formState.errors.email?.message}>
        <Input id="signup-email" type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field
        label={t("password")}
        htmlFor="signup-password"
        hint={t("passwordHint")}
        error={form.formState.errors.password?.message}
      >
        <Input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          {...form.register("password")}
        />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? t("signingUp") : t("signUp")}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {t("haveAccount")}{" "}
        <Link href="/login" className="text-foreground underline">
          {t("signInInstead")}
        </Link>
      </p>
    </form>
  );
}
