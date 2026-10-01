import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CHANNEL_CAPABILITIES,
  CHANNEL_FIELDS,
  CHANNEL_LABELS,
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
  INTEGRATION_IDS,
  findIntegration,
  integrationFields,
  integrationForChannel,
} from "../integrations/catalog.js";
import {
  CHANNEL_TYPES,
  channelAccepts,
  channelRulesPatchSchema,
  channelRulesSchema,
  mergeChannelRules,
  createChannelSchema,
  discordChannelConfigSchema,
  emailChannelConfigSchema,
  teamsChannelConfigSchema,
  updateChannelSchema,
  webhookChannelConfigSchema,
  type ChannelType,
} from "../schemas/alerting.js";
import {
  googleChatChannelConfigSchema,
  gotifyChannelConfigSchema,
  phoneChannelConfigSchema,
  matrixChannelConfigSchema,
  mattermostChannelConfigSchema,
  ntfyChannelConfigSchema,
  opsgenieChannelConfigSchema,
  pagerDutyChannelConfigSchema,
  pushbulletChannelConfigSchema,
  pushoverChannelConfigSchema,
  rocketChatChannelConfigSchema,
  slackWebhookChannelConfigSchema,
  splunkOnCallChannelConfigSchema,
  zulipChannelConfigSchema,
} from "../schemas/channel-configs.js";

/* The config schema of every channel that is set up through a form. */
const FORM_SCHEMAS: Partial<Record<ChannelType, z.ZodObject>> = {
  email: emailChannelConfigSchema,
  teams: teamsChannelConfigSchema,
  discord: discordChannelConfigSchema,
  webhook: webhookChannelConfigSchema,
  slack_webhook: slackWebhookChannelConfigSchema,
  google_chat: googleChatChannelConfigSchema,
  mattermost: mattermostChannelConfigSchema,
  rocketchat: rocketChatChannelConfigSchema,
  zulip: zulipChannelConfigSchema,
  matrix: matrixChannelConfigSchema,
  pagerduty: pagerDutyChannelConfigSchema,
  opsgenie: opsgenieChannelConfigSchema,
  splunk_oncall: splunkOnCallChannelConfigSchema,
  pushover: pushoverChannelConfigSchema,
  pushbullet: pushbulletChannelConfigSchema,
  ntfy: ntfyChannelConfigSchema,
  gotify: gotifyChannelConfigSchema,
  sms: phoneChannelConfigSchema,
  voice: phoneChannelConfigSchema,
};

describe("integration catalog", () => {
  it("describes every channel type exactly once per table", () => {
    for (const type of CHANNEL_TYPES) {
      expect(CHANNEL_FIELDS[type], type).toBeDefined();
      expect(CHANNEL_CAPABILITIES[type], type).toBeDefined();
      expect(CHANNEL_LABELS[type], type).toBeTruthy();
    }
    expect(Object.keys(CHANNEL_FIELDS).sort()).toEqual([...CHANNEL_TYPES].sort());
  });

  it("every type has a gallery entry without a preset, and IDs are unique URL slugs", () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect([...ids].sort()).toEqual([...INTEGRATION_IDS].sort());
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    for (const type of CHANNEL_TYPES) {
      expect(
        INTEGRATIONS.some((i) => i.type === type && i.preset === undefined),
        type,
      ).toBe(true);
    }
    for (const i of INTEGRATIONS) expect(INTEGRATION_CATEGORIES).toContain(i.category);
  });

  it("form fields match the config schemas: same keys, same required-ness", () => {
    for (const [type, schema] of Object.entries(FORM_SCHEMAS) as Array<
      [ChannelType, z.ZodObject]
    >) {
      const fields = CHANNEL_FIELDS[type];
      /* The webhook's signing secret is generated, not a form field. */
      const schemaKeys = Object.keys(schema.shape).filter(
        (k) => !(type === "webhook" && k === "secret"),
      );
      expect(fields.map((f) => f.key).sort(), type).toEqual(schemaKeys.sort());
      for (const field of fields) {
        const optional = schema.shape[field.key]?.safeParse(undefined).success === true;
        expect(optional, `${type}.${field.key} required`).toBe(
          !field.required || field.defaultValue !== undefined,
        );
        if (field.kind === "select") {
          for (const option of field.options ?? []) {
            expect(schema.shape[field.key]?.safeParse(option).success, option).toBe(true);
          }
        }
      }
    }
  });

  it("setup styles: forms have fields, the Slack app and Telegram don't", () => {
    for (const type of CHANNEL_TYPES) {
      const { setup } = CHANNEL_CAPABILITIES[type];
      expect(CHANNEL_FIELDS[type].length > 0, type).toBe(setup === "form");
    }
  });

  it("finds entries by ID and by a channel's type and config", () => {
    expect(findIntegration("google-chat")?.type).toBe("google_chat");
    expect(findIntegration("nope")).toBeUndefined();
    expect(integrationForChannel("webhook").id).toBe("webhook");
    expect(integrationForChannel("opsgenie", { region: "eu" }).id).toBe("opsgenie");
    expect(integrationForChannel("opsgenie", { region: "jsm" }).id).toBe("jira-service-management");
  });

  it("a preset hides the fields it fixes and is valid for the type", () => {
    const jsm = findIntegration("jira-service-management");
    expect(jsm).toBeDefined();
    if (jsm === undefined) return;
    expect(integrationFields(jsm).map((f) => f.key)).toEqual(["apiKey"]);
    expect(
      opsgenieChannelConfigSchema.safeParse({
        apiKey: "eb243592-faa2-4ba2-a551-1afdf565c889",
        ...jsm.preset,
      }).success,
    ).toBe(true);
    const zapier = findIntegration("zapier");
    expect(zapier && integrationFields(zapier).map((f) => f.key)).toEqual(["url", "headers"]);
  });
});

describe("channel rules", () => {
  const all = channelRulesSchema.parse({});

  it("default to every event from every severity", () => {
    expect(all).toEqual({
      events: {
        triggered: true,
        acknowledged: true,
        resolved: true,
        reminder: true,
        flapping: true,
      },
      minSeverity: "low",
    });
    expect(channelAccepts(all, "triggered", "low")).toBe(true);
    expect(channelAccepts(all, "flapping", "critical")).toBe(true);
  });

  it("filter by severity floor and by event", () => {
    const pager = channelRulesSchema.parse({
      minSeverity: "high",
      events: { reminder: false, flapping: false },
    });
    expect(channelAccepts(pager, "triggered", "critical")).toBe(true);
    expect(channelAccepts(pager, "triggered", "high")).toBe(true);
    expect(channelAccepts(pager, "triggered", "low")).toBe(false);
    expect(channelAccepts(pager, "resolved", "high")).toBe(true);
    expect(channelAccepts(pager, "reminder", "critical")).toBe(false);
    const criticalOnly = channelRulesSchema.parse({ minSeverity: "critical" });
    expect(channelAccepts(criticalOnly, "triggered", "high")).toBe(false);
  });

  it("tools that mirror the incident always get its acknowledgement and recovery", () => {
    const quiet = channelRulesSchema.parse({
      minSeverity: "high",
      events: { acknowledged: false, resolved: false },
    });
    expect(channelAccepts(quiet, "resolved", "critical")).toBe(false);
    expect(channelAccepts(quiet, "resolved", "critical", true)).toBe(true);
    expect(channelAccepts(quiet, "acknowledged", "high", true)).toBe(true);
    /* Not for incidents it never heard about, and other events keep their switches. */
    expect(channelAccepts(quiet, "resolved", "low", true)).toBe(false);
    const muted = channelRulesSchema.parse({ events: { triggered: false, reminder: false } });
    expect(channelAccepts(muted, "resolved", "critical", true)).toBe(false);
    expect(channelAccepts(muted, "reminder", "critical", true)).toBe(false);
  });

  it("a partial change keeps everything it doesn't mention", () => {
    const current = channelRulesSchema.parse({ minSeverity: "high", events: { reminder: false } });
    expect(
      mergeChannelRules(current, channelRulesPatchSchema.parse({ minSeverity: "critical" })),
    ).toEqual({ ...current, minSeverity: "critical" });
    const merged = mergeChannelRules(
      current,
      channelRulesPatchSchema.parse({ events: { flapping: false } }),
    );
    expect(merged.minSeverity).toBe("high");
    expect(merged.events).toMatchObject({ reminder: false, flapping: false, triggered: true });
    expect(mergeChannelRules(current, {})).toEqual(current);
  });

  it("are part of the create and update bodies, and rules alone are an update", () => {
    expect(
      createChannelSchema.safeParse({
        type: "pagerduty",
        name: "Pager",
        config: {},
        rules: { minSeverity: "high" },
      }).success,
    ).toBe(true);
    expect(updateChannelSchema.safeParse({ rules: { minSeverity: "critical" } }).success).toBe(
      true,
    );
    expect(updateChannelSchema.safeParse({}).success).toBe(false);
    expect(channelRulesSchema.safeParse({ minSeverity: "urgent" }).success).toBe(false);
    expect(channelRulesSchema.safeParse({ events: { exploded: true } }).success).toBe(false);
  });
});
