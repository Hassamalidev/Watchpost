/*
 * API keys for the public API (PRODUCT.md §6.13): admins make a key with the scopes it needs, see
 * the whole key once, and revoke keys. The list shows only the start of each key.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  API_SCOPES,
  createApiKeySchema,
  type ApiKeyView,
  type ApiScope,
  type CreateApiKeyInput,
  type CreatedApiKey,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Loading } from "@/components/ui/skeleton";
import { api, errorMessage, wsPath } from "@/lib/api";
import { formatDateTime, relativeTime } from "@/lib/format";

const EXPIRY_DAYS = [null, 30, 90, 365] as const;

export function ApiKeys({ ws }: { ws: string }) {
  const t = useTranslations("settings.apiKeys");
  const tc = useTranslations("common");
  const client = useQueryClient();
  const queryKey = ["api-keys", ws] as const;
  const keys = useQuery({
    queryKey,
    queryFn: async () => (await api<{ data: ApiKeyView[] }>(wsPath(ws, "/api-keys"))).data,
  });
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<ApiScope[]>(["monitors:read", "incidents:read"]);
  const [expiresInDays, setExpiresInDays] = React.useState<number | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  /* The key just made: shown until the page is left, and never again. */
  const [made, setMade] = React.useState<CreatedApiKey | null>(null);

  const create = useMutation({
    mutationFn: (body: CreateApiKeyInput) =>
      api<CreatedApiKey>(wsPath(ws, "/api-keys"), { method: "POST", body }),
    onSuccess: async (key) => {
      setMade(key);
      setName("");
      await client.invalidateQueries({ queryKey });
    },
    onError: (err) => setProblem(errorMessage(err)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api<ApiKeyView>(wsPath(ws, `/api-keys/${id}`), { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey }),
  });

  function submit() {
    setProblem(null);
    const parsed = createApiKeySchema.safeParse({ name: name.trim(), scopes, expiresInDays });
    if (!parsed.success) {
      setProblem(
        parsed.error.issues[0]?.path[0] === "name" ? t("nameRequired") : t("scopeRequired"),
      );
      return;
    }
    create.mutate(parsed.data);
  }

  const active = (keys.data ?? []).filter((key) => key.revokedAt === null);

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="api-keys-heading">
      <div className="grid gap-1">
        <h2 id="api-keys-heading" className="text-base font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("intro")}{" "}
          <Link href="/docs/api" className="font-medium text-brand underline">
            {t("docsLink")}
          </Link>
        </p>
      </div>

      {made && (
        <Alert tone="info">
          <div className="grid gap-2">
            <p className="font-medium">{t("madeTitle", { name: made.name })}</p>
            <CopyField label={t("madeLabel")} value={made.key} />
            <p className="text-sm">{t("madeHint")}</p>
          </div>
        </Alert>
      )}

      {keys.isLoading ? (
        <Loading rows={2} />
      ) : keys.isError ? (
        <Alert tone="error">{errorMessage(keys.error)}</Alert>
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="grid gap-2">
          {active.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {key.name} <span className="font-mono text-xs font-normal">{key.prefix}…</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {key.scopes.join(", ")} ·{" "}
                  {key.lastUsedAt === null
                    ? t("neverUsed")
                    : t("lastUsed", { when: relativeTime(key.lastUsedAt) })}
                  {key.expiresAt === null
                    ? ""
                    : ` · ${t("expires", { when: formatDateTime(key.expiresAt) })}`}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={revoke.isPending}
                aria-label={t("revokeNamed", { name: key.name })}
                onClick={() => {
                  if (globalThis.confirm(t("confirmRevoke", { name: key.name }))) {
                    revoke.mutate(key.id);
                  }
                }}
              >
                {t("revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && <Alert tone="error">{errorMessage(revoke.error)}</Alert>}

      <form
        className="grid max-w-xl gap-4 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {problem && <Alert tone="error">{problem}</Alert>}
        <Field label={t("name")} htmlFor="api-key-name" hint={t("nameHint")}>
          <Input
            id="api-key-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">{t("scopes")}</legend>
          <p className="text-xs text-muted-foreground">{t("scopesHint")}</p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {API_SCOPES.map((scope) => (
              <label key={scope} className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) =>
                    setScopes((held) =>
                      e.target.checked ? [...held, scope] : held.filter((s) => s !== scope),
                    )
                  }
                />
                <span className="font-mono text-xs">{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label={t("expiry")} htmlFor="api-key-expiry">
          <Select
            id="api-key-expiry"
            value={expiresInDays === null ? "" : String(expiresInDays)}
            onChange={(e) =>
              setExpiresInDays(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            {EXPIRY_DAYS.map((days) => (
              <option key={days ?? "never"} value={days ?? ""}>
                {days === null ? t("expiryNever") : t("expiryDays", { days })}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? tc("saving") : t("create")}
          </Button>
        </div>
      </form>
    </section>
  );
}
