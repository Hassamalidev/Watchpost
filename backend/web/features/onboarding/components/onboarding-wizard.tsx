/*
 * Onboarding (PRODUCT.md §14): workspace → paste a URL and pick suggested monitors → where alerts go
 * → send a test alert. Target: a delivered test alert within 3 minutes of signing up.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { CircleCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { createWorkspace, getSession, listWorkspaces } from "@/lib/auth";
import { monitorsApi, type CreateMonitorBody } from "@/features/monitors/api";
import { addToDefaultPolicy, integrationsApi } from "@/features/integrations/api";

type Step = "workspace" | "monitors" | "alerts" | "test";
const STEPS: Step[] = ["workspace", "monitors", "alerts", "test"];
const STEP_LABEL = {
  workspace: "stepWorkspace",
  monitors: "stepMonitors",
  alerts: "stepAlerts",
  test: "stepTest",
} as const;

interface Suggestion {
  key: string;
  label: string;
  body: CreateMonitorBody;
  checked: boolean;
}

/* Monitors worth creating for a URL: homepage, a health path, its certificate and its domain. */
export function suggestMonitors(
  raw: string,
  t: (
    key: "suggestHome" | "suggestHealth" | "suggestSsl" | "suggestDomain",
    values: Record<string, string>,
  ) => string,
): Suggestion[] | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname;
  const home = `${url.origin}/`;
  const health = `${url.origin}/health`;
  const labels = host.split(".");
  const domain = labels.length >= 2 ? labels.slice(-2).join(".") : host;
  const list: Suggestion[] = [
    {
      key: "home",
      label: t("suggestHome", { url: home }),
      body: { settings: { name: `${host} homepage` }, config: { type: "http", url: home } },
      checked: true,
    },
    {
      key: "health",
      label: t("suggestHealth", { url: health }),
      body: { settings: { name: `${host} health` }, config: { type: "http", url: health } },
      checked: false,
    },
  ];
  if (url.protocol === "https:") {
    list.push({
      key: "ssl",
      label: t("suggestSsl", { host }),
      body: { settings: { name: `${host} certificate` }, config: { type: "ssl", host } },
      checked: true,
    });
  }
  if (labels.length >= 2 && !/^\d+$/.test(labels.at(-1) ?? "")) {
    list.push({
      key: "domain",
      label: t("suggestDomain", { domain }),
      body: { settings: { name: `${domain} domain` }, config: { type: "domain", domain } },
      checked: true,
    });
  }
  return list;
}

export function OnboardingWizard() {
  const t = useTranslations("onboarding");
  const tApp = useTranslations("app");
  const router = useRouter();
  const session = useQuery({ queryKey: ["session"], queryFn: getSession });
  const [step, setStep] = React.useState<Step>("workspace");
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = React.useState("");
  const [url, setUrl] = React.useState("https://");
  const [suggestions, setSuggestions] = React.useState<Suggestion[] | null>(null);
  const [email, setEmail] = React.useState("");
  const [channel, setChannel] = React.useState<{ id: string; name: string } | null>(null);
  const [result, setResult] = React.useState<{ ok: boolean; error?: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (session.data === null) router.replace("/login?next=/onboarding");
    if (session.data) {
      setEmail((current) => current || session.data!.user.email);
      setWorkspaceName(
        (current) => current || `${session.data!.user.name.split(" ")[0]}'s workspace`,
      );
    }
  }, [session.data, router]);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (session.isPending || !session.data) {
    return <p className="text-muted-foreground">{tApp("loading")}</p>;
  }

  const index = STEPS.indexOf(step);
  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
        </CardTitle>
        <ol className="flex flex-wrap gap-2 text-xs" aria-label={t("title")}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === index ? "step" : undefined}
              className={i === index ? "font-semibold text-foreground" : "text-muted-foreground"}
            >
              {i + 1}. {t(STEP_LABEL[s])}
            </li>
          ))}
        </ol>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error && <Alert tone="error">{error}</Alert>}

        {step === "workspace" && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const existing = await listWorkspaces();
                const workspace = existing[0] ?? (await createWorkspace(workspaceName.trim()));
                setWorkspaceId(workspace.id);
                setStep("monitors");
              });
            }}
          >
            <Field label={t("workspaceName")} htmlFor="ob-workspace" hint={t("workspaceHint")}>
              <Input
                id="ob-workspace"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                required
              />
            </Field>
            <div>
              <Button type="submit" disabled={busy || workspaceName.trim() === ""}>
                {t("continue")}
              </Button>
            </div>
          </form>
        )}

        {step === "monitors" && workspaceId && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (suggestions === null) {
                const list = suggestMonitors(url, t);
                if (list === undefined) setError(t("urlInvalid"));
                else setSuggestions(list);
                return;
              }
              void run(async () => {
                for (const s of suggestions.filter((x) => x.checked)) {
                  await monitorsApi.create(workspaceId, s.body);
                }
                setStep("alerts");
              });
            }}
          >
            <Field label={t("urlLabel")} htmlFor="ob-url" hint={t("urlHint")}>
              <Input
                id="ob-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setSuggestions(null);
                }}
              />
            </Field>
            {suggestions && (
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("suggestions")}</legend>
                {suggestions.map((s) => (
                  <label key={s.key} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={s.checked}
                      onChange={(e) =>
                        setSuggestions((list) =>
                          (list ?? []).map((x) =>
                            x.key === s.key ? { ...x, checked: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    {s.label}
                  </label>
                ))}
              </fieldset>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                {suggestions === null ? t("continue") : busy ? t("creating") : t("createMonitors")}
              </Button>
            </div>
          </form>
        )}

        {step === "alerts" && workspaceId && (
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const created = await integrationsApi.createChannel(workspaceId, {
                  type: "email",
                  name: email.trim(),
                  config: { to: [email.trim()] },
                });
                await addToDefaultPolicy(workspaceId, created.id);
                setChannel({ id: created.id, name: created.name });
                setStep("test");
              });
            }}
          >
            <p className="text-sm text-muted-foreground">{t("alertsIntro")}</p>
            <Field label={t("alertEmail")} htmlFor="ob-email">
              <Input
                id="ob-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <div>
              <Button type="submit" disabled={busy}>
                {t("addChannel")}
              </Button>
            </div>
          </form>
        )}

        {step === "test" && workspaceId && channel && (
          <div className="grid gap-4">
            <p className="text-sm text-muted-foreground">{t("testIntro")}</p>
            {result?.ok === true && (
              <Alert tone="success">
                <span className="inline-flex items-center gap-1">
                  <CircleCheck aria-hidden className="size-4" />
                  {t("delivered", { channel: channel.name })}
                </span>
              </Alert>
            )}
            {result?.ok === false && (
              <Alert tone="error">{t("failed", { error: result.error ?? "" })}</Alert>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                variant={result?.ok ? "outline" : "default"}
                onClick={() =>
                  void run(async () => {
                    const res = await integrationsApi.sendTest(workspaceId, channel.id);
                    setResult(res.ok ? { ok: true } : { ok: false, error: res.error });
                  })
                }
              >
                {busy ? t("sending") : t("sendTest")}
              </Button>
              {result?.ok && (
                <Button onClick={() => router.push(`/w/${workspaceId}/overview`)}>
                  {t("done")}
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
