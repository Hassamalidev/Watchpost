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
