/*
 * Personal contact methods and notification rules (PRODUCT.md §6.5, §9.5). A user's rules say, per
 * urgency, which of their contact methods hears about an incident and how many minutes after it was
 * assigned to them. `planFanOut` turns rules into the timed list alerting sends from.
 */
import { z } from "zod";
import type { Severity } from "../constants/regions.js";

/* `push` is a browser or installed app on one device (web push). */
export const CONTACT_METHOD_TYPES = ["email", "sms", "voice", "push"] as const;
export type ContactMethodType = (typeof CONTACT_METHOD_TYPES)[number];

export const URGENCIES = ["high", "low"] as const;
export type Urgency = (typeof URGENCIES)[number];

/* Critical and high incidents page; low ones (an expiring certificate) only write. */
export function urgencyOf(severity: Severity): Urgency {
  return severity === "low" ? "low" : "high";
}

export const MAX_CONTACT_METHODS = 10;
export const MAX_RULES_PER_URGENCY = 10;
export const MAX_RULE_DELAY_MINUTES = 120;

/*
 * The rules a newly verified contact method gets (§6.5): email at once for both urgencies, SMS two
 * minutes into a high-urgency incident, a call after five. `undefined` means no rule.
 */
export const DEFAULT_RULE_DELAYS: Record<ContactMethodType, Record<Urgency, number | undefined>> = {
  email: { high: 0, low: 0 },
  sms: { high: 2, low: undefined },
  voice: { high: 5, low: undefined },
  push: { high: 0, low: 0 },
};

export const createContactMethodSchema = z.object({
  type: z.enum(CONTACT_METHOD_TYPES),
  /* An email address, a phone number, or a push subscription's endpoint URL. */
  address: z.string().trim().min(3).max(1_000),
  label: z.string().trim().min(1).max(60).optional(),
  /* Push only: the browser's keys from `PushSubscription.toJSON()`. */
  push: z
    .object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
      auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
    })
    .optional(),
});
export type CreateContactMethodInput = z.infer<typeof createContactMethodSchema>;

export const contactCodeSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const notificationRuleSchema = z.object({
  contactMethodId: z.uuid(),
  delayMinutes: z.number().int().min(0).max(MAX_RULE_DELAY_MINUTES),
});
export const replaceRulesSchema = z.object({
  rules: z.array(notificationRuleSchema).min(1).max(MAX_RULES_PER_URGENCY),
});
export type NotificationRuleInput = z.infer<typeof notificationRuleSchema>;

export interface ContactMethodView {
  id: string;
  type: ContactMethodType;
  address: string;
  label: string | null;
  verified: boolean;
  createdAt: string;
}

export interface NotificationRuleView {
  contactMethodId: string;
  delayMinutes: number;
}

export type NotificationRulesView = Record<Urgency, NotificationRuleView[]>;

export interface FanOutMethod {
  id: string;
  type: ContactMethodType;
  address: string;
  verified: boolean;
}

export interface FanOutStep {
  contactMethodId: string;
  type: ContactMethodType;
  address: string;
  delayMinutes: number;
}

const TYPE_ORDER: Record<ContactMethodType, number> = { email: 0, push: 1, sms: 2, voice: 3 };

/*
 * Who-hears-when for one user and one urgency: one step per verified contact method that has a rule,
 * at its earliest delay, soonest first. Unverified or deleted methods are skipped. A user whose rules
 * reach nothing is still told: their first verified method (email before SMS before a call) at once.
 */
export function planFanOut(
  rules: readonly NotificationRuleView[],
  methods: readonly FanOutMethod[],
): FanOutStep[] {
  const usable = new Map(methods.filter((m) => m.verified).map((m) => [m.id, m]));
  const earliest = new Map<string, number>();
  for (const rule of rules) {
    if (!usable.has(rule.contactMethodId)) continue;
    const known = earliest.get(rule.contactMethodId);
    if (known === undefined || rule.delayMinutes < known) {
      earliest.set(rule.contactMethodId, rule.delayMinutes);
    }
  }
  const byPreference = (a: FanOutMethod, b: FanOutMethod) =>
    TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.id.localeCompare(b.id);
  if (earliest.size === 0) {
    const fallback = [...usable.values()].sort(byPreference)[0];
    return fallback === undefined
      ? []
      : [
          {
            contactMethodId: fallback.id,
            type: fallback.type,
            address: fallback.address,
            delayMinutes: 0,
          },
        ];
  }
  return [...earliest.entries()]
    .map(([id, delayMinutes]) => {
      const method = usable.get(id) as FanOutMethod;
      return { contactMethodId: id, type: method.type, address: method.address, delayMinutes };
    })
    .sort(
      (a, b) =>
        a.delayMinutes - b.delayMinutes ||
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        a.contactMethodId.localeCompare(b.contactMethodId),
    );
}
