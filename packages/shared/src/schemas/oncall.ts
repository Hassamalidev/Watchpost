/*
 * On-call schedules (PRODUCT.md §6.5, §9.5). A schedule has a timezone and layers; each layer
 * rotates through its participants from a first handoff, optionally only inside restriction windows.
 * A higher layer wins over a lower one, and an override wins over every layer.
 */
import { z } from "zod";

export const ROTATIONS = ["daily", "weekly", "custom"] as const;
export type Rotation = (typeof ROTATIONS)[number];

export const MAX_LAYERS = 5;
export const MAX_PARTICIPANTS = 50;
export const MAX_RESTRICTIONS = 14;
/* The longest stretch one timeline request may cover. */
export const MAX_TIMELINE_DAYS = 62;

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, for example 09:00");
const instant = z.iso.datetime({ offset: true });

/*
 * A window inside which the layer is on call, in the schedule's timezone. Days are ISO weekdays
 * (1 = Monday … 7 = Sunday) on which the window starts; `end` at or before `start` runs past midnight.
 */
export const restrictionSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  start: clockTime,
  end: clockTime,
});
export type Restriction = z.infer<typeof restrictionSchema>;

export const scheduleLayerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    rotation: z.enum(ROTATIONS),
    /* Custom rotations only: hours each participant holds the shift. */
    shiftHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 28)
      .optional(),
    /* The first handoff. Daily and weekly rotations hand off at this wall-clock time ever after. */
    startsAt: instant,
    endsAt: instant.optional(),
    /* User IDs in rotation order; someone may appear more than once. */
    participants: z.array(z.uuid()).min(1).max(MAX_PARTICIPANTS),
    restrictions: z.array(restrictionSchema).max(MAX_RESTRICTIONS).default([]),
  })
  .refine((l) => l.rotation !== "custom" || l.shiftHours !== undefined, {
    message: "A custom rotation needs its shift length in hours.",
    path: ["shiftHours"],
  })
  .refine((l) => l.endsAt === undefined || l.endsAt > l.startsAt, {
    message: "The layer must end after it starts.",
    path: ["endsAt"],
  });
export type ScheduleLayerInput = z.infer<typeof scheduleLayerSchema>;

export const createScheduleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  timezone: z.string().min(1).max(64),
  /* The last layer in the list wins where layers overlap. */
  layers: z.array(scheduleLayerSchema).min(1).max(MAX_LAYERS),
});
export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;

export const updateScheduleSchema = createScheduleSchema.partial();
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;

export const createOverrideSchema = z
  .object({ userId: z.uuid(), startsAt: instant, endsAt: instant })
  .refine((o) => o.endsAt > o.startsAt, {
    message: "The override must end after it starts.",
    path: ["endsAt"],
  });
export type CreateOverrideInput = z.infer<typeof createOverrideSchema>;

export interface OnCallPerson {
  userId: string;
  /* Null for someone who has left the workspace. */
  name: string | null;
}

export interface ScheduleLayerView {
  id: string;
  name: string;
  rotation: Rotation;
  shiftHours: number | null;
  startsAt: string;
  endsAt: string | null;
  participants: OnCallPerson[];
  restrictions: Restriction[];
}

export interface ScheduleOverrideView {
  id: string;
  user: OnCallPerson;
  startsAt: string;
  endsAt: string;
}

export interface ScheduleView {
  id: string;
  name: string;
  timezone: string;
  layers: ScheduleLayerView[];
  /* Overrides that haven't ended yet. */
  overrides: ScheduleOverrideView[];
  createdAt: string;
}

export interface ScheduleSummary {
  id: string;
  name: string;
  timezone: string;
  onCall: OnCallPerson | null;
}

/* A stretch during which the same person (or nobody) is on call. */
export interface OnCallSegment {
  startsAt: string;
  endsAt: string;
  user: OnCallPerson | null;
  /* Why: an override, or the name of the layer whose turn it is. */
  source: "override" | "layer" | null;
  layerName: string | null;
}

export interface OnCallNow {
  at: string;
  current: OnCallSegment | null;
  /* The next stretch with someone else (or nobody) on call. */
  next: OnCallSegment | null;
}

/*
 * Escalation policies (PRODUCT.md §6.5, §9.5): ordered steps, each tried a delay after the one
 * before it, repeated `repeat` more times, until someone acknowledges.
 */
export const ESCALATION_TARGET_TYPES = ["user", "schedule", "channel"] as const;
export type EscalationTargetType = (typeof ESCALATION_TARGET_TYPES)[number];

export const MAX_ESCALATION_STEPS = 10;
export const MAX_STEP_TARGETS = 10;
export const MAX_ESCALATION_REPEATS = 9;
export const MAX_STEP_DELAY_MINUTES = 24 * 60;

export const escalationTargetSchema = z.object({
  type: z.enum(ESCALATION_TARGET_TYPES),
  id: z.uuid(),
});
export type EscalationTarget = z.infer<typeof escalationTargetSchema>;

export const escalationStepSchema = z.object({
  /* Minutes after the step before it (after the incident opened, for the first step). */
  delayMinutes: z.number().int().min(0).max(MAX_STEP_DELAY_MINUTES),
  targets: z.array(escalationTargetSchema).min(1).max(MAX_STEP_TARGETS),
});
export type EscalationStep = z.infer<typeof escalationStepSchema>;

export const createEscalationPolicySchema = z.object({
  name: z.string().trim().min(1).max(80),
  /* How many more times the steps run after the first round. */
  repeat: z.number().int().min(0).max(MAX_ESCALATION_REPEATS).default(0),
  steps: z.array(escalationStepSchema).min(1).max(MAX_ESCALATION_STEPS),
});
export type CreateEscalationPolicyInput = z.infer<typeof createEscalationPolicySchema>;
export const updateEscalationPolicySchema = createEscalationPolicySchema.partial();
export type UpdateEscalationPolicyInput = z.infer<typeof updateEscalationPolicySchema>;

export interface EscalationTargetView extends EscalationTarget {
  /* Null for a channel (named by the integrations list) or something deleted since. */
  name: string | null;
}

export interface EscalationPolicyView {
  id: string;
  name: string;
  repeat: number;
  steps: { delayMinutes: number; targets: EscalationTargetView[] }[];
  createdAt: string;
}

/* Where an incident's escalation stands. */
export interface IncidentEscalationView {
  policyName: string;
  /* Steps run so far, and how many there are across all rounds. */
  stepsRun: number;
  totalSteps: number;
  nextStepAt: string | null;
  /* Why it stopped: someone took the incident, it was resolved, or every step ran. */
  finished: "acknowledged" | "resolved" | "exhausted" | null;
}
