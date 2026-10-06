/*
 * Verifying the number of an SMS or voice channel: show what alerting it costs, send a one-time code
 * (which costs the SMS price in credits), and confirm the code. The channel can be saved once the
 * number is verified; the API refuses it otherwise.
 */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import type { PhoneCost } from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { integrationsApi } from "../api";

type Step =
  | { name: "idle" }
  | { name: "priced"; cost: PhoneCost }
  | { name: "sent"; cost: PhoneCost }
  | { name: "verified" };

export function PhoneVerify({ ws, phone }: { ws: string; phone: string }) {
  const t = useTranslations("integrations");
  const [step, setStep] = React.useState<Step>({ name: "idle" });
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const number = phone.trim();

  /* Another number starts over. */
  React.useEffect(() => {
    setStep({ name: "idle" });
    setCode("");
    setError(null);
  }, [number]);

  async function run(action: () => Promise<Step>) {
    setBusy(true);
    setError(null);
    try {
      setStep(await action());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const cost = step.name === "priced" || step.name === "sent" ? step.cost : null;

  return (
    <div className="grid gap-3 rounded-md border bg-muted/40 p-3 text-sm">
      {error && <Alert tone="error">{error}</Alert>}
      {step.name === "verified" ? (
        <Alert tone="success">{t("phoneVerified")}</Alert>
      ) : (
        <>
          <p className="text-muted-foreground">{t("phoneIntro")}</p>
          {cost && (
            <p>
              {t("phoneCost", {
                country: cost.country,
                sms: cost.smsCredits,
                voice: cost.voiceCredits,
              })}
            </p>
          )}
          {step.name === "idle" && (
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || number === ""}
                onClick={() =>
                  void run(async () => ({
                    name: "priced",
                    cost: await integrationsApi.phoneCost(ws, number),
                  }))
                }
              >
                {t("phoneCheckCost")}
              </Button>
            </div>
          )}
          {step.name === "priced" && (
            <div>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => ({
                    name: "sent",
                    cost: await integrationsApi.sendPhoneCode(ws, number),
                  }))
                }
              >
                {t("phoneSendCode", { credits: step.cost.smsCredits })}
              </Button>
            </div>
          )}
          {step.name === "sent" && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-40">
                <Field label={t("phoneCode")} htmlFor="phone-code">
                  <Input
                    id="phone-code"
                    value={code}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </Field>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={busy || code.trim().length !== 6}
                onClick={() =>
                  void run(async () => {
                    await integrationsApi.confirmPhone(ws, number, code.trim());
                    return { name: "verified" };
                  })
                }
              >
                {t("phoneConfirm")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
