/*
 * Escalation policies on the on-call page: who is paged first, who after how many minutes, and how
 * often the steps repeat; and which policy the default alert route pages through.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  MAX_ESCALATION_REPEATS,
  MAX_ESCALATION_STEPS,
  roleCan,
  type CreateEscalationPolicyInput,
  type EscalationPolicyView,
  type ScheduleSummary,
  type WorkspaceRole,
} from "@app/shared";
import { can, useWorkspace } from "@/components/app/workspace-context";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";

interface Member {
  userId: string;
  name: string;
  role: WorkspaceRole;
}

interface AlertRoute {
  id: string;
  name: string;
  isDefault: boolean;
  rules: { escalationPolicyId?: string | null } & Record<string, unknown>;
}

interface StepForm {
  delay: string;
  /* "user:<id>" or "schedule:<id>"; empty until chosen. */
  target: string;
}

const keys = {
  policies: (ws: string) => ["escalation-policies", ws] as const,
  routes: (ws: string) => ["alert-policies", ws] as const,
};

/* The API body for the form, or what stops it. */
export function toPolicyBody(
  name: string,
  repeat: number,
  steps: StepForm[],
): { body: CreateEscalationPolicyInput } | { problem: "name" | "target" | "delay"; step?: number } {
  if (name.trim() === "") return { problem: "name" };
  const out: CreateEscalationPolicyInput["steps"] = [];
  for (const [i, step] of steps.entries()) {
    const [type, id] = step.target.split(":");
    if ((type !== "user" && type !== "schedule") || id === undefined || id === "") {
      return { problem: "target", step: i };
    }
    const delay = Number(step.delay);
    if (!Number.isInteger(delay) || delay < 0 || delay > 1_440)
      return { problem: "delay", step: i };
    out.push({ delayMinutes: delay, targets: [{ type, id }] });
  }
  return { body: { name: name.trim(), repeat, steps: out } };
}

function PolicyForm({
  ws,
  schedules,
  onDone,
}: {
  ws: string;
  schedules: ScheduleSummary[];
  onDone: () => void;
}) {
  const t = useTranslations("oncall.escalation");
  const client = useQueryClient();
  const [name, setName] = React.useState("");
  const [repeat, setRepeat] = React.useState(0);
  const [steps, setSteps] = React.useState<StepForm[]>([{ delay: "0", target: "" }]);
  const [problem, setProblem] = React.useState<string | undefined>();
  const members = useQuery({
    queryKey: ["members", ws],
    queryFn: async () => (await api<{ data: Member[] }>(wsPath(ws, "/members"))).data,
  });
  const people = (members.data ?? []).filter((m) => roleCan(m.role, "contact:manage"));
  const create = useMutation({
    mutationFn: (body: CreateEscalationPolicyInput) =>
      api<EscalationPolicyView>(wsPath(ws, "/escalation-policies"), { method: "POST", body }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.policies(ws) });
      onDone();
    },
  });
  const setStep = (index: number, patch: Partial<StepForm>) =>
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));

  return (
    <form
      className="grid gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const result = toPolicyBody(name, repeat, steps);
        if ("problem" in result) {
          setProblem(t(`problems.${result.problem}`, { number: (result.step ?? 0) + 1 }));
          return;
        }
        setProblem(undefined);
        create.mutate(result.body);
      }}
    >
      {(problem ?? (create.isError ? errorMessage(create.error) : undefined)) !== undefined && (
        <Alert tone="error">{problem ?? errorMessage(create.error)}</Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("name")} htmlFor="escalation-name">
          <Input
            id="escalation-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label={t("repeat")} htmlFor="escalation-repeat" hint={t("repeatHint")}>
          <Select
            id="escalation-repeat"
            value={String(repeat)}
            onChange={(e) => setRepeat(Number(e.target.value))}
          >
            {Array.from({ length: MAX_ESCALATION_REPEATS + 1 }, (_, n) => (
              <option key={n} value={n}>
                {t("repeatTimes", { count: n })}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {steps.map((step, index) => (
        <fieldset key={index} className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
          <legend className="mb-1 text-sm font-semibold">{t("step", { number: index + 1 })}</legend>
          <Field label={t("page")} htmlFor={`escalation-target-${index}`}>
            <Select
              id={`escalation-target-${index}`}
              value={step.target}
              onChange={(e) => setStep(index, { target: e.target.value })}
            >
              <option value="">{t("choose")}</option>
              <optgroup label={t("schedules")}>
                {schedules.map((s) => (
                  <option key={s.id} value={`schedule:${s.id}`}>
                    {t("onCallFor", { name: s.name })}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("people")}>
                {people.map((p) => (
                  <option key={p.userId} value={`user:${p.userId}`}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
          <Field
            label={index === 0 ? t("delayFirst") : t("delay")}
            htmlFor={`escalation-delay-${index}`}
          >
            <Input
              id={`escalation-delay-${index}`}
              type="number"
              min={0}
              max={1440}
              value={step.delay}
              onChange={(e) => setStep(index, { delay: e.target.value })}
            />
          </Field>
          {steps.length > 1 && (
            <Button
              type="button"
              variant="outline"
              aria-label={t("removeStep", { number: index + 1 })}
              onClick={() => setSteps(steps.filter((_, i) => i !== index))}
            >
              {t("remove")}
            </Button>
          )}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        {steps.length < MAX_ESCALATION_STEPS && (
          <Button
            type="button"
            variant="outline"
            onClick={() => setSteps([...steps, { delay: "5", target: "" }])}
          >
            {t("addStep")}
          </Button>
        )}
        <Button type="submit" disabled={create.isPending}>
          {t("create")}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

export function EscalationPolicies({ schedules }: { schedules: ScheduleSummary[] }) {
  const t = useTranslations("oncall.escalation");
  const workspace = useWorkspace();
  const ws = workspace.id;
  const client = useQueryClient();
  const canWrite = can(workspace.role, "schedule:write");
  const canRoute = can(workspace.role, "alertPolicy:write");
  const [adding, setAdding] = React.useState(false);
  const policies = useQuery({
    queryKey: keys.policies(ws),
    queryFn: async () =>
      (await api<{ data: EscalationPolicyView[] }>(wsPath(ws, "/escalation-policies"))).data,
  });
  const routes = useQuery({
    queryKey: keys.routes(ws),
    queryFn: async () => (await api<{ data: AlertRoute[] }>(wsPath(ws, "/alert-policies"))).data,
  });
  const route = (routes.data ?? []).find((r) => r.isDefault);
  const current = route?.rules.escalationPolicyId ?? null;
  const link = useMutation({
    /* One setting, set on the server: the route's channels are never re-sent from this page. */
    mutationFn: (policyId: string | null) =>
      api(wsPath(ws, "/alert-policies/default/escalation"), {
        method: "PUT",
        body: { escalationPolicyId: policyId },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.routes(ws) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(wsPath(ws, `/escalation-policies/${id}`), { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.policies(ws) }),
  });
  const list = policies.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t("hint")}</p>
        {(policies.isError || routes.isError) && (
          <Alert tone="error">{errorMessage(policies.error ?? routes.error)}</Alert>
        )}
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        {policies.isPending ? (
          <Loading rows={1} />
        ) : list.length === 0 ? (
          <p className="text-sm">{t("empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label={t("title")}>
            {list.map((policy) => (
              <li key={policy.id} className="grid gap-1 px-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="flex-1 font-medium">
                    {policy.name}
                    {policy.id === current && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {t("inUse")}
                      </span>
                    )}
                  </p>
                  {canWrite && policy.id !== current && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={remove.isPending}
                      aria-label={t("deleteNamed", { name: policy.name })}
                      onClick={() => remove.mutate(policy.id)}
                    >
                      {t("delete")}
                    </Button>
                  )}
                </div>
                <ol className="grid gap-0.5 text-sm text-muted-foreground">
                  {policy.steps.map((step, index) => (
                    <li key={index}>
                      {index === 0 && step.delayMinutes === 0
                        ? t("stepNow", {
                            who: step.targets.map((x) => x.name ?? t("someone")).join(", "),
                          })
                        : t("stepAfter", {
                            minutes: step.delayMinutes,
                            who: step.targets.map((x) => x.name ?? t("someone")).join(", "),
                          })}
                    </li>
                  ))}
                  {policy.repeat > 0 && <li>{t("thenRepeat", { count: policy.repeat })}</li>}
                </ol>
              </li>
            ))}
          </ul>
        )}

        {route !== undefined && list.length > 0 && (
          <Field label={t("use")} htmlFor="escalation-use" hint={t("useHint")} className="max-w-md">
            <Select
              id="escalation-use"
              value={current ?? ""}
              disabled={!canRoute || link.isPending}
              onChange={(e) => link.mutate(e.target.value === "" ? null : e.target.value)}
            >
              <option value="">{t("useNone")}</option>
              {list.map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {link.isError && <Alert tone="error">{errorMessage(link.error)}</Alert>}

        {canWrite &&
          (adding ? (
            <PolicyForm ws={ws} schedules={schedules} onDone={() => setAdding(false)} />
          ) : (
            <div>
              <Button type="button" variant="outline" onClick={() => setAdding(true)}>
                {t("new")}
              </Button>
            </div>
          ))}
      </CardContent>
    </Card>
  );
}
