/*
 * Config handling shared by form-based adapters, driven by the catalog's field list in @app/shared:
 * validation with per-field errors, and write-only secrets. A secret never leaves through the API
 * (`redact` answers SECRET_MASK, or only the origin of a secret URL). On update, an empty or unchanged
 * secret keeps the stored value, but only while the server it is sent to stays the same: otherwise an
 * admin could point the channel at their own server and collect a token they can't read (the rule
 * monitors follow, D-048).
 */
import { CHANNEL_FIELDS, SECRET_MASK, type ChannelField, type ChannelType } from "@app/shared";
import type { z } from "zod";
import { ValidationError } from "../../../core/errors.js";
import type { ChannelAdapter, PrepareContext } from "../types/adapter.js";

const fieldPath = (key: string) => `body.config.${key}`;

/*
 * Zod's wording for a missing value ("expected string, received undefined") isn't for people, and a
 * refused record key (a header name) hides its reason one level down.
 */
function messageOf(issue: { code?: string; message: string; issues?: unknown }): string {
  if (issue.code === "invalid_type" && issue.message.endsWith("received undefined")) {
    return "is required";
  }
  if (issue.code === "invalid_key" && Array.isArray(issue.issues)) {
    const inner = (issue.issues as Array<{ message?: string }>)[0]?.message;
    if (inner !== undefined) return inner;
  }
  return issue.message;
}

/* Parses a config; a failure names the field, in words a form can show next to it. */
export function parseConfigWith<C>(schema: z.ZodType<C>, input: unknown, label: string): C {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const errors = parsed.error.issues.map((issue) => ({
    path: fieldPath(issue.path.map(String).join(".")),
    message: messageOf(issue),
  }));
  const first = parsed.error.issues[0];
  const where = first !== undefined && first.path.length > 0 ? `${first.path.join(".")} ` : "";
  throw new ValidationError(
    `${label}: ${where}${first === undefined ? "the settings are invalid" : messageOf(first)}`,
    errors,
  );
}

const originOf = (value: unknown): string | undefined => {
  try {
    return new URL(String(value)).origin;
  } catch {
    return undefined;
  }
};

/* What the API shows for a stored secret: the mask, or where a secret URL points. */
export function maskSecret(field: Pick<ChannelField, "kind">, value: unknown): string {
  const origin = field.kind === "url" ? originOf(value) : undefined;
  return origin === undefined ? SECRET_MASK : `${origin}/${SECRET_MASK}`;
}

type ConfigHandling<C> = Required<Pick<ChannelAdapter<C>, "parseConfig" | "prepare" | "redact">>;

export function formConfig<C extends object>(
  type: ChannelType,
  schema: z.ZodType<C>,
  label: string,
): ConfigHandling<C> {
  const fields = CHANNEL_FIELDS[type];
  const secrets = fields.filter((f) => f.secret === true);
  /* Where secrets are sent: the non-secret URL fields (a server address). */
  const targets = fields.filter((f) => f.kind === "url" && f.secret !== true);

  return {
    parseConfig: (input) => parseConfigWith(schema, input, label),

    async prepare(input: unknown, ctx: PrepareContext) {
      const next: Record<string, unknown> = { ...((input ?? {}) as Record<string, unknown>) };
      const previous = ctx.previous as Record<string, unknown> | undefined;
      /*
       * Any change to where secrets go counts, not just another host: two tenants of one hosted
       * service share an origin and differ only by path.
       */
      const addressOf = (value: unknown) => String(value ?? "").replace(/\/+$/, "");
      const moved = () =>
        previous !== undefined &&
        targets.some(
          (t) => addressOf(next[t.key] || t.defaultValue) !== addressOf(previous[t.key]),
        );

      for (const field of secrets) {
        const value = next[field.key];
        /* null removes an optional secret. */
        if (value === null) {
          delete next[field.key];
          continue;
        }
        const stored = previous?.[field.key];
        const unchanged =
          value === undefined ||
          value === "" ||
          value === SECRET_MASK ||
          (stored !== undefined && value === maskSecret(field, stored));
        if (!unchanged) continue;
        if (stored === undefined) {
          /* Nothing to keep: a required field then fails validation as missing. */
          delete next[field.key];
          continue;
        }
        if (moved()) {
          throw new ValidationError(`${label}: enter ${field.key} again for the new server.`, [
            {
              path: fieldPath(field.key),
              message: "Enter this again: the server address changed.",
            },
          ]);
        }
        next[field.key] = stored;
      }
      /* Empty optional inputs mean "not set". */
      for (const [key, value] of Object.entries(next)) if (value === "") delete next[key];
      return parseConfigWith(schema, next, label);
    },

    redact(config) {
      const shown: Record<string, unknown> = { ...(config as Record<string, unknown>) };
      for (const field of secrets) {
        if (shown[field.key] !== undefined) shown[field.key] = maskSecret(field, shown[field.key]);
      }
      return shown;
    },
  };
}
