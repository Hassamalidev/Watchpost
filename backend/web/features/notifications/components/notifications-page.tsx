/*
 * My notifications: your own contact methods (an address is used once you enter the code sent to
 * it) and, per urgency, which of them hears about an incident and how long after it reaches you.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  CONTACT_METHOD_TYPES,
  URGENCIES,
  type ContactMethodType,
  type ContactMethodView,
  type NotificationRulesView,
  type Urgency,
} from "@app/shared";
import { useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { ChatLinksCard } from "./chat-links";

/* Minutes after the incident reaches you; "off" leaves the method out. */
const DELAYS = [0, 1, 2, 5, 10, 15, 30, 60] as const;
type Choice = "off" | `${(typeof DELAYS)[number]}`;

const keys = {
  methods: (ws: string) => ["contact-methods", ws] as const,
  rules: (ws: string) => ["notification-rules", ws] as const,
};

function VerifyForm({ ws, method }: { ws: string; method: ContactMethodView }) {
  const t = useTranslations("notifications");
  const client = useQueryClient();
  const [code, setCode] = React.useState("");
  const base = wsPath(ws, `/me/contact-methods/${method.id}`);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: keys.methods(ws) });
    await client.invalidateQueries({ queryKey: keys.rules(ws) });
  };
  const confirm = useMutation({
    mutationFn: () => api(`${base}/confirm`, { method: "POST", body: { code: code.trim() } }),
    onSuccess: refresh,
  });
  const resend = useMutation({ mutationFn: () => api(`${base}/code`, { method: "POST" }) });
  const inputId = `code-${method.id}`;

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        confirm.mutate();
      }}
    >
      {confirm.isError && <Alert tone="error">{errorMessage(confirm.error)}</Alert>}
      {resend.isError && <Alert tone="error">{errorMessage(resend.error)}</Alert>}
      {resend.isSuccess && (
        <Alert tone="success">{t("codeSent", { address: method.address })}</Alert>
      )}
      <Field
        label={t("codeFor", { address: method.address })}
        htmlFor={inputId}
        hint={t("codeHint")}
      >
        <Input
          id={inputId}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          className="max-w-40"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={confirm.isPending}>
          {t("verify")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={resend.isPending}
          onClick={() => resend.mutate()}
        >
          {t("resend")}
        </Button>
      </div>
    </form>
  );
}

function MethodsCard({ ws, methods }: { ws: string; methods: ContactMethodView[] }) {
  const t = useTranslations("notifications");
  const client = useQueryClient();
  const [type, setType] = React.useState<ContactMethodType>("email");
  const [address, setAddress] = React.useState("");
  const [label, setLabel] = React.useState("");
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: keys.methods(ws) });
    await client.invalidateQueries({ queryKey: keys.rules(ws) });
  };
  const add = useMutation({
    mutationFn: () =>
      api(wsPath(ws, "/me/contact-methods"), {
        method: "POST",
        body: {
          type,
          address: address.trim(),
          ...(label.trim() === "" ? {} : { label: label.trim() }),
        },
      }),
    onSuccess: async () => {
      setAddress("");
      setLabel("");
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(wsPath(ws, `/me/contact-methods/${id}`), { method: "DELETE" }),
    onSuccess: refresh,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("methods")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t("methodsHint")}</p>
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        <ul className="divide-y rounded-lg border" aria-label={t("methods")}>
          {methods.map((m) => (
            <li key={m.id} className="grid gap-3 px-3 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium break-all">{m.address}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`types.${m.type}`)}
                    {m.label ? ` · ${m.label}` : ""}
                  </p>
                </div>
                <span className="text-sm font-medium">
                  {m.verified ? t("verified") : t("unverified")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.id)}
                  aria-label={t("removeAddress", { address: m.address })}
                >
                  {t("remove")}
                </Button>
              </div>
              {!m.verified && <VerifyForm ws={ws} method={m} />}
            </li>
          ))}
        </ul>
        <form
          className="grid max-w-md gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <h3 className="text-sm font-semibold">{t("add")}</h3>
          {add.isError && <Alert tone="error">{errorMessage(add.error)}</Alert>}
          <Field label={t("kind")} htmlFor="method-type">
            <Select
              id="method-type"
              value={type}
              onChange={(e) => {
                setType(e.target.value as ContactMethodType);
                setAddress("");
              }}
            >
              {CONTACT_METHOD_TYPES.map((option) => (
                <option key={option} value={option}>
                  {t(`types.${option}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={type === "email" ? t("address") : t("phone")}
            htmlFor="method-address"
            hint={type === "email" ? t("addressHint") : t("phoneHint")}
          >
            <Input
              id="method-address"
              type={type === "email" ? "email" : "tel"}
              autoComplete={type === "email" ? "email" : "tel"}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            />
          </Field>
          <Field label={t("label")} htmlFor="method-label">
            <Input
              id="method-label"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>
          <div>
            <Button type="submit" disabled={add.isPending}>
              {t("addButton")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RulesCard({
  ws,
  urgency,
  methods,
  rules,
}: {
  ws: string;
  urgency: Urgency;
  methods: ContactMethodView[];
  rules: NotificationRulesView;
}) {
  const t = useTranslations("notifications");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const verified = methods.filter((m) => m.verified);
  const saved = React.useMemo(() => {
    const out: Record<string, Choice> = {};
    for (const rule of rules[urgency])
      out[rule.contactMethodId] = String(rule.delayMinutes) as Choice;
    return out;
  }, [rules, urgency]);
  const [draft, setDraft] = React.useState<Record<string, Choice>>({});
  const choiceOf = (id: string): Choice => draft[id] ?? saved[id] ?? "off";
  const chosen = verified.filter((m) => choiceOf(m.id) !== "off");

  const save = useMutation({
    mutationFn: () =>
      api<NotificationRulesView>(wsPath(ws, `/me/notification-rules/${urgency}`), {
        method: "PUT",
        body: {
          rules: chosen.map((m) => ({
            contactMethodId: m.id,
            delayMinutes: Number(choiceOf(m.id)),
          })),
        },
      }),
    onSuccess: async () => {
      setDraft({});
      await client.invalidateQueries({ queryKey: keys.rules(ws) });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t(`urgency.${urgency}.title`)}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen.length > 0) save.mutate();
          }}
        >
          <p className="text-sm text-muted-foreground">{t(`urgency.${urgency}.hint`)}</p>
          {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
          {save.isSuccess && <Alert tone="success">{t("rulesSaved")}</Alert>}
          {chosen.length === 0 && <Alert tone="error">{t("pickOne")}</Alert>}
          {verified.map((m) => {
            const id = `rule-${urgency}-${m.id}`;
            const current = choiceOf(m.id);
            /* A delay saved through the API that this list doesn't offer still shows. */
            const options: Choice[] = ["off", ...DELAYS.map((d) => String(d) as Choice)];
            if (!options.includes(current)) options.push(current);
            return (
              <Field key={m.id} label={m.address} htmlFor={id} className="max-w-md">
                <Select
                  id={id}
                  value={current}
                  onChange={(e) => setDraft({ ...draft, [m.id]: e.target.value as Choice })}
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option === "off"
                        ? t("delay.off")
                        : option === "0"
                          ? t("delay.now")
                          : t("delay.after", { minutes: Number(option) })}
                    </option>
                  ))}
                </Select>
              </Field>
            );
          })}
          <div>
            <Button type="submit" disabled={save.isPending || chosen.length === 0}>
              {save.isPending ? tc("saving") : t("saveRules")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function NotificationsPage() {
  const t = useTranslations("notifications");
  const ws = useWorkspace().id;
  const methods = useQuery({
    queryKey: keys.methods(ws),
    queryFn: async () =>
      (await api<{ data: ContactMethodView[] }>(wsPath(ws, "/me/contact-methods"))).data,
  });
  const rules = useQuery({
    queryKey: keys.rules(ws),
    queryFn: () => api<NotificationRulesView>(wsPath(ws, "/me/notification-rules")),
  });

  return (
    <div className="grid max-w-3xl gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("lead")}</p>
      </div>
      {(methods.isError || rules.isError) && (
        <Alert tone="error">{errorMessage(methods.error ?? rules.error)}</Alert>
      )}
      {methods.data === undefined || rules.data === undefined ? (
        methods.isError || rules.isError ? null : (
          <Loading rows={3} />
        )
      ) : (
        <>
          <MethodsCard ws={ws} methods={methods.data} />
          <React.Suspense fallback={null}>
            <ChatLinksCard ws={ws} />
          </React.Suspense>
          <section className="grid gap-4" aria-labelledby="rules-heading">
            <div className="grid gap-1">
              <h2 id="rules-heading" className="text-base font-semibold">
                {t("rules")}
              </h2>
              <p className="text-sm text-muted-foreground">{t("rulesHint")}</p>
            </div>
            {URGENCIES.map((urgency) => (
              <RulesCard
                key={urgency}
                ws={ws}
                urgency={urgency}
                methods={methods.data}
                rules={rules.data}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
