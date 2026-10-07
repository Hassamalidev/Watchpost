/* P4-T02: fan-out timing from personal rules (PRODUCT.md §6.5, §9.5). */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULE_DELAYS,
  planFanOut,
  replaceRulesSchema,
  urgencyOf,
  type FanOutMethod,
} from "../index.js";

const email: FanOutMethod = {
  id: "a-email",
  type: "email",
  address: "sara@example.com",
  verified: true,
};
const sms: FanOutMethod = { id: "b-sms", type: "sms", address: "+14155550123", verified: true };
const voice: FanOutMethod = {
  id: "c-voice",
  type: "voice",
  address: "+14155550123",
  verified: true,
};

const timing = (steps: ReturnType<typeof planFanOut>) =>
  steps.map((s) => `${s.type}@${s.delayMinutes}`);

describe("planFanOut", () => {
  it("follows the default high-urgency rules: email now, SMS after 2 min, a call after 5", () => {
    const rules = [email, sms, voice].flatMap((m) => {
      const delay = DEFAULT_RULE_DELAYS[m.type].high;
      return delay === undefined ? [] : [{ contactMethodId: m.id, delayMinutes: delay }];
    });
    expect(timing(planFanOut(rules, [voice, sms, email]))).toEqual(["email@0", "sms@2", "voice@5"]);
  });

  it("keeps low urgency to email by default", () => {
    const rules = [email, sms, voice].flatMap((m) => {
      const delay = DEFAULT_RULE_DELAYS[m.type].low;
      return delay === undefined ? [] : [{ contactMethodId: m.id, delayMinutes: delay }];
    });
    expect(timing(planFanOut(rules, [email, sms, voice]))).toEqual(["email@0"]);
  });

  it("orders by delay, then email before SMS before a call", () => {
    const rules = [
      { contactMethodId: voice.id, delayMinutes: 0 },
      { contactMethodId: sms.id, delayMinutes: 0 },
      { contactMethodId: email.id, delayMinutes: 10 },
    ];
    expect(timing(planFanOut(rules, [email, sms, voice]))).toEqual([
      "sms@0",
      "voice@0",
      "email@10",
    ]);
  });

  it("uses a method once, at its earliest delay", () => {
    const rules = [
      { contactMethodId: sms.id, delayMinutes: 15 },
      { contactMethodId: sms.id, delayMinutes: 3 },
    ];
    expect(timing(planFanOut(rules, [sms]))).toEqual(["sms@3"]);
  });

  it("skips unverified and deleted methods", () => {
    const rules = [
      { contactMethodId: email.id, delayMinutes: 0 },
      { contactMethodId: sms.id, delayMinutes: 2 },
      { contactMethodId: "gone", delayMinutes: 1 },
    ];
    expect(timing(planFanOut(rules, [email, { ...sms, verified: false }]))).toEqual(["email@0"]);
  });

  it("still tells someone whose rules reach nothing, through their first verified method", () => {
    expect(timing(planFanOut([], [voice, sms, email]))).toEqual(["email@0"]);
    expect(
      timing(
        planFanOut(
          [{ contactMethodId: email.id, delayMinutes: 0 }],
          [sms, { ...email, verified: false }],
        ),
      ),
    ).toEqual(["sms@0"]);
    expect(planFanOut([], [{ ...email, verified: false }])).toEqual([]);
  });
});

describe("urgency and rule input", () => {
  it("pages for critical and high incidents and writes for low ones", () => {
    expect(urgencyOf("critical")).toBe("high");
    expect(urgencyOf("high")).toBe("high");
    expect(urgencyOf("low")).toBe("low");
  });

  it("accepts delays from 0 to 120 minutes and refuses an empty rule list", () => {
    const id = "0190e2e0-0000-7000-8000-000000000001";
    expect(
      replaceRulesSchema.safeParse({ rules: [{ contactMethodId: id, delayMinutes: 120 }] }).success,
    ).toBe(true);
    expect(
      replaceRulesSchema.safeParse({ rules: [{ contactMethodId: id, delayMinutes: 121 }] }).success,
    ).toBe(false);
    expect(replaceRulesSchema.safeParse({ rules: [] }).success).toBe(false);
  });
});
