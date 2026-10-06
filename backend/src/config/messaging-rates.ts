/*
 * What an SMS and a one-minute call cost us per country, and what they cost the customer in alert
 * credits (PRODUCT.md §5: "per-country multipliers", "voice calls cost 2+ credits per minute").
 *
 * One credit may cost us at most CREDIT_PROVIDER_COST_MICROS, which is what a collected payment sets
 * aside per credit (§11 "Upstream funding"). So credits = ceil(provider cost / that amount), and the
 * rule holds for any rate entered here.
 *
 * ESTIMATES, NOT QUOTES: the rates below are rounded-up estimates entered on 2026-10-01 and must be
 * replaced with the provider's current price list before real messages are sent (P3-T05b, owner
 * checklist in docs/integrations/sms.md). Only listed countries can be verified, so an unknown
 * destination can never be sent at a loss.
 */
import { CREDIT_PROVIDER_COST_MICROS } from "./plans.js";

export interface CountryRate {
  /* ISO 3166-1 alpha-2. */
  country: string;
  /* Calling code without "+". */
  prefix: string;
  /* Micro-USD per outbound SMS segment, carrier fees included. */
  smsMicros: number;
  /* Micro-USD per minute of an outbound call to a mobile. */
  voiceMinuteMicros: number;
}

export const MESSAGING_RATES: readonly CountryRate[] = [
  { country: "US", prefix: "1", smsMicros: 13_000, voiceMinuteMicros: 14_000 },
  { country: "GB", prefix: "44", smsMicros: 55_000, voiceMinuteMicros: 35_000 },
  { country: "DE", prefix: "49", smsMicros: 110_000, voiceMinuteMicros: 80_000 },
  { country: "FR", prefix: "33", smsMicros: 85_000, voiceMinuteMicros: 60_000 },
  { country: "NL", prefix: "31", smsMicros: 115_000, voiceMinuteMicros: 90_000 },
  { country: "ES", prefix: "34", smsMicros: 85_000, voiceMinuteMicros: 50_000 },
  { country: "IT", prefix: "39", smsMicros: 95_000, voiceMinuteMicros: 60_000 },
  { country: "IE", prefix: "353", smsMicros: 90_000, voiceMinuteMicros: 60_000 },
  { country: "SE", prefix: "46", smsMicros: 60_000, voiceMinuteMicros: 40_000 },
  { country: "AU", prefix: "61", smsMicros: 55_000, voiceMinuteMicros: 80_000 },
  { country: "SG", prefix: "65", smsMicros: 50_000, voiceMinuteMicros: 40_000 },
  { country: "IN", prefix: "91", smsMicros: 85_000, voiceMinuteMicros: 30_000 },
  { country: "AE", prefix: "971", smsMicros: 140_000, voiceMinuteMicros: 250_000 },
  { country: "PK", prefix: "92", smsMicros: 270_000, voiceMinuteMicros: 200_000 },
];

/*
 * +1 is shared: Canada is priced like the US here, and the Caribbean and Pacific members of the plan
 * cost many times more, so they are not served. These are their area codes.
 */
const NANP_CANADA = new Set(
  "204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 403 416 418 428 431 437 438 450 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905".split(
    " ",
  ),
);
const NANP_OTHER = new Set(
  "242 246 264 268 284 340 345 441 473 649 658 664 670 671 684 721 758 767 784 787 809 829 849 868 869 876 939".split(
    " ",
  ),
);
/* Premium and special services, never a person's phone. */
const NANP_SPECIAL = /^(900|976|8(00|33|44|55|66|77|88)|5(00|21|22|33|44|66|77|88))$/;

export interface PhoneRate {
  country: string;
  smsCredits: number;
  /* One call is billed as one minute; calls are cut off at 60 seconds. */
  voiceCredits: number;
  smsMicros: number;
  voiceMinuteMicros: number;
}

const MIN_VOICE_CREDITS = 2;
const creditsFor = (micros: number) => Math.max(1, Math.ceil(micros / CREDIT_PROVIDER_COST_MICROS));

/* The rate for an E.164 number, or undefined when its country isn't served. */
export function rateForPhone(phone: string): PhoneRate | undefined {
  const digits = phone.replace(/^\+/, "");
  /* The longest matching calling code wins (353 before 3x). */
  const rate = [...MESSAGING_RATES]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .find((r) => digits.startsWith(r.prefix));
  if (rate === undefined) return undefined;

  let country = rate.country;
  if (rate.prefix === "1") {
    if (digits.length !== 11) return undefined;
    const area = digits.slice(1, 4);
    if (NANP_OTHER.has(area) || NANP_SPECIAL.test(area)) return undefined;
    if (NANP_CANADA.has(area)) country = "CA";
  }
  return {
    country,
    smsCredits: creditsFor(rate.smsMicros),
    voiceCredits: Math.max(MIN_VOICE_CREDITS, creditsFor(rate.voiceMinuteMicros)),
    smsMicros: rate.smsMicros,
    voiceMinuteMicros: rate.voiceMinuteMicros,
  };
}

export const SUPPORTED_PHONE_COUNTRIES: readonly string[] = [
  ...MESSAGING_RATES.map((r) => r.country),
  "CA",
].sort();
