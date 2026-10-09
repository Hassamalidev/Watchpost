/*
 * Two-factor sign-in for the signed-in person (PRODUCT.md §6.11): turn it on with the password, add
 * the key to an authenticator app, prove one code, keep the backup codes. Shown on the Security
 * page, and on its own when a workspace requires it and the person hasn't set it up.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { twoFactor } from "@/lib/auth";

type Step =
  | { name: "idle" }
  | { name: "confirm"; secret: string; uri: string; backupCodes: string[] }
  | { name: "done"; backupCodes: string[] };

export function TwoFactorCard({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  /* Called after it was switched on or off, so the page can read the new state. */
  onChanged: () => void;
}) {
  const t = useTranslations("security.twoFactor");
  const [step, setStep] = React.useState<Step>({ name: "idle" });
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setProblem(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const result = await twoFactor.enable(password);
      setPassword("");
      setStep({
        name: "confirm",
        secret: new URL(result.totpURI).searchParams.get("secret") ?? "",
        uri: result.totpURI,
        backupCodes: result.backupCodes,
      });
    });
  const confirm = (backupCodes: string[]) =>
    run(async () => {
      await twoFactor.verify(code.trim());
      setCode("");
      setStep({ name: "done", backupCodes });
      onChanged();
    });
  const switchOff = () =>
    run(async () => {
      await twoFactor.disable(password);
      setPassword("");
      setStep({ name: "idle" });
      onChanged();
    });

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="two-factor-heading">
      <div className="grid gap-1">
        <h2 id="two-factor-heading" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
      </div>
      {problem && <Alert tone="error">{problem}</Alert>}

      {step.name === "done" && (
        <Alert tone="info">
          <div className="grid gap-2">
            <p className="font-medium">{t("onNow")}</p>
            <CopyField label={t("backupCodes")} value={step.backupCodes.join(" ")} />
            <p className="text-sm">{t("backupHint")}</p>
          </div>
        </Alert>
      )}

      {step.name === "confirm" ? (
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm(step.backupCodes);
          }}
        >
          <p className="text-sm">{t("addToApp")}</p>
          <CopyField label={t("secret")} value={step.secret} />
          <p className="text-sm">
            <a href={step.uri} className="underline">
              {t("openApp")}
            </a>
          </p>
          <Field label={t("code")} htmlFor="two-factor-code" hint={t("codeHint")}>
            <Input
              id="two-factor-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              {t("confirm")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="grid max-w-xl gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void (enabled ? switchOff() : start());
          }}
        >
          <p className="text-sm font-medium">{enabled ? t("isOn") : t("isOff")}</p>
          <Field
            label={t("password")}
            htmlFor="two-factor-password"
            hint={enabled ? t("passwordOffHint") : t("passwordOnHint")}
          >
            <Input
              id="two-factor-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant={enabled ? "outline" : "default"}
              disabled={busy || password === ""}
            >
              {enabled ? t("switchOff") : t("switchOn")}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
