/*
 * Create or edit a schedule: name, time zone and layers. Each layer rotates through its people from
 * a first handoff; "only during" limits it to a window, and a later layer wins where two overlap.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  MAX_LAYERS,
  ROTATIONS,
  roleCan,
  type CreateScheduleInput,
  type Rotation,
  type ScheduleView,
  type WorkspaceRole,
} from "@app/shared";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { api, wsPath } from "@/lib/api";
import { isoToLocalInput, localInputToIso } from "../calendar";

const ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
type Limit = "always" | "window";

export interface LayerForm {
  name: string;
  rotation: Rotation;
  shiftHours: string;
  /* A `datetime-local` value in the browser's time zone. */
  start: string;
  participants: string[];
  limit: Limit;
  days: number[];
  from: string;
  to: string;
}

export interface ScheduleFormState {
  name: string;
  timezone: string;
  layers: LayerForm[];
}

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function emptyLayer(name: string, now = new Date()): LayerForm {
  const start = new Date(now);
  start.setHours(9, 0, 0, 0);
  return {
    name,
    rotation: "weekly",
    shiftHours: "12",
    start: isoToLocalInput(start.toISOString()),
    participants: [],
    limit: "always",
    days: [1, 2, 3, 4, 5],
    from: "09:00",
    to: "18:00",
  };
}

export function formOf(schedule: ScheduleView): ScheduleFormState {
  return {
    name: schedule.name,
    timezone: schedule.timezone,
    layers: schedule.layers.map((layer) => {
      const window = layer.restrictions[0];
      return {
        name: layer.name,
        rotation: layer.rotation,
        shiftHours: String(layer.shiftHours ?? 12),
        start: isoToLocalInput(layer.startsAt),
        participants: layer.participants.map((p) => p.userId),
        limit: window === undefined ? "always" : "window",
        days: window?.days ?? [1, 2, 3, 4, 5],
        from: window?.start ?? "09:00",
        to: window?.end ?? "18:00",
      };
    }),
  };
}

/* The API body for the form, or what stops it. */
export function toScheduleBody(
  form: ScheduleFormState,
):
  | { body: CreateScheduleInput }
  | { problem: "name" | "start" | "participants" | "shiftHours" | "days"; layer?: number } {
  if (form.name.trim() === "") return { problem: "name" };
  const layers: CreateScheduleInput["layers"] = [];
  for (const [i, layer] of form.layers.entries()) {
    const startsAt = localInputToIso(layer.start);
    if (startsAt === undefined) return { problem: "start", layer: i };
    if (layer.participants.length === 0) return { problem: "participants", layer: i };
    const hours = Number(layer.shiftHours);
    if (layer.rotation === "custom" && (!Number.isInteger(hours) || hours < 1 || hours > 672)) {
      return { problem: "shiftHours", layer: i };
    }
    if (layer.limit === "window" && layer.days.length === 0) return { problem: "days", layer: i };
    layers.push({
      name: layer.name.trim() || `Layer ${i + 1}`,
      rotation: layer.rotation,
      ...(layer.rotation === "custom" ? { shiftHours: hours } : {}),
      startsAt,
      participants: layer.participants,
      restrictions:
        layer.limit === "window"
          ? [{ days: [...layer.days].sort((a, b) => a - b), start: layer.from, end: layer.to }]
          : [],
    });
  }
  return { body: { name: form.name.trim(), timezone: form.timezone, layers } };
}

interface Member {
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
}

function LayerFields({
  index,
  layer,
  people,
  onChange,
  onRemove,
}: {
  index: number;
  layer: LayerForm;
  people: Member[];
  onChange: (layer: LayerForm) => void;
  onRemove: (() => void) | undefined;
}) {
  const t = useTranslations("oncall.form");
  const id = (field: string) => `layer-${index}-${field}`;
  const set = <K extends keyof LayerForm>(key: K, value: LayerForm[K]) =>
    onChange({ ...layer, [key]: value });
  const nameOf = (userId: string) => people.find((p) => p.userId === userId)?.name ?? userId;
  const [adding, setAdding] = React.useState("");

  return (
    <fieldset className="grid gap-3 rounded-lg border p-3">
      <legend className="px-1 text-sm font-semibold">{t("layer", { number: index + 1 })}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("layerName")} htmlFor={id("name")}>
          <Input
            id={id("name")}
            value={layer.name}
            maxLength={60}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label={t("rotation")} htmlFor={id("rotation")}>
          <Select
            id={id("rotation")}
            value={layer.rotation}
            onChange={(e) => set("rotation", e.target.value as Rotation)}
          >
            {ROTATIONS.map((rotation) => (
              <option key={rotation} value={rotation}>
                {t(`rotations.${rotation}`)}
              </option>
            ))}
          </Select>
        </Field>
        {layer.rotation === "custom" && (
          <Field label={t("shiftHours")} htmlFor={id("hours")}>
            <Input
              id={id("hours")}
              type="number"
              min={1}
              max={672}
              value={layer.shiftHours}
              onChange={(e) => set("shiftHours", e.target.value)}
            />
          </Field>
        )}
        <Field label={t("firstHandoff")} htmlFor={id("start")} hint={t("firstHandoffHint")}>
          <Input
            id={id("start")}
            type="datetime-local"
            value={layer.start}
            onChange={(e) => set("start", e.target.value)}
          />
        </Field>
      </div>

      <div className="grid gap-2">
        <p className="text-sm font-medium" id={id("people-label")}>
          {t("people")}
        </p>
        {layer.participants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noPeople")}</p>
        ) : (
          <ol className="grid gap-1" aria-labelledby={id("people-label")}>
            {layer.participants.map((userId, position) => (
              <li key={`${userId}-${position}`} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-muted-foreground">{position + 1}.</span>
                <span className="flex-1">{nameOf(userId)}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={t("removePerson", { name: nameOf(userId) })}
                  onClick={() =>
                    set(
                      "participants",
                      layer.participants.filter((_, i) => i !== position),
                    )
                  }
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t("addPerson")} htmlFor={id("add")} className="min-w-52 flex-1">
            <Select id={id("add")} value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">{t("choosePerson")}</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name} ({p.email})
                </option>
              ))}
            </Select>
          </Field>
          <Button
            type="button"
            variant="outline"
            disabled={adding === ""}
            onClick={() => {
              set("participants", [...layer.participants, adding]);
              setAdding("");
            }}
          >
            {t("add")}
          </Button>
        </div>
      </div>

      <Field label={t("limit")} htmlFor={id("limit")} className="max-w-xs">
        <Select
          id={id("limit")}
          value={layer.limit}
          onChange={(e) => set("limit", e.target.value as Limit)}
        >
          <option value="always">{t("limits.always")}</option>
          <option value="window">{t("limits.window")}</option>
        </Select>
      </Field>
      {layer.limit === "window" && (
        <div className="grid gap-3">
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-1 text-sm font-medium">{t("days")}</legend>
            {WEEKDAYS.map((day) => (
              <label key={day} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={layer.days.includes(day)}
                  onChange={(e) =>
                    set(
                      "days",
                      e.target.checked ? [...layer.days, day] : layer.days.filter((d) => d !== day),
                    )
                  }
                />
                {t(`weekdays.${day}`)}
              </label>
            ))}
          </fieldset>
          <div className="grid max-w-xs grid-cols-2 gap-3">
            <Field label={t("from")} htmlFor={id("from")}>
              <Input
                id={id("from")}
                type="time"
                value={layer.from}
                onChange={(e) => set("from", e.target.value)}
              />
            </Field>
            <Field label={t("to")} htmlFor={id("to")}>
              <Input
                id={id("to")}
                type="time"
                value={layer.to}
                onChange={(e) => set("to", e.target.value)}
              />
            </Field>
          </div>
        </div>
      )}
      {onRemove !== undefined && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onRemove}>
            {t("removeLayer")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

export function ScheduleForm({
  ws,
  initial,
  submitLabel,
  pending,
  error,
  onSubmit,
}: {
  ws: string;
  initial?: ScheduleFormState | undefined;
  submitLabel: string;
  pending: boolean;
  error?: string | undefined;
  onSubmit: (body: CreateScheduleInput) => void;
}) {
  const t = useTranslations("oncall.form");
  const [form, setForm] = React.useState<ScheduleFormState>(
    () => initial ?? { name: "", timezone: browserZone(), layers: [emptyLayer(t("defaultLayer"))] },
  );
  const [problem, setProblem] = React.useState<string | undefined>();
  const members = useQuery({
    queryKey: ["members", ws],
    queryFn: async () => (await api<{ data: Member[] }>(wsPath(ws, "/members"))).data,
  });
  /* Only people who can be paged can be on call. */
  const people = (members.data ?? []).filter((m) => roleCan(m.role, "contact:manage"));
  const zones = ZONES.includes(form.timezone) ? ZONES : [form.timezone, ...ZONES];

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const result = toScheduleBody(form);
        if ("problem" in result) {
          setProblem(
            t(`problems.${result.problem}`, {
              number: (result.layer ?? 0) + 1,
            }),
          );
          return;
        }
        setProblem(undefined);
        onSubmit(result.body);
      }}
    >
      {(problem ?? error) !== undefined && <Alert tone="error">{problem ?? error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("name")} htmlFor="schedule-name">
          <Input
            id="schedule-name"
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label={t("timezone")} htmlFor="schedule-tz" hint={t("timezoneHint")}>
          <Select
            id="schedule-tz"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {form.layers.map((layer, index) => (
        <LayerFields
          key={index}
          index={index}
          layer={layer}
          people={people}
          onChange={(next) =>
            setForm({ ...form, layers: form.layers.map((l, i) => (i === index ? next : l)) })
          }
          onRemove={
            form.layers.length > 1
              ? () => setForm({ ...form, layers: form.layers.filter((_, i) => i !== index) })
              : undefined
          }
        />
      ))}
      <div className="flex flex-wrap gap-2">
        {form.layers.length < MAX_LAYERS && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              setForm({
                ...form,
                layers: [
                  ...form.layers,
                  emptyLayer(t("layer", { number: form.layers.length + 1 })),
                ],
              })
            }
          >
            {t("addLayer")}
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("layersHint")}</p>
    </form>
  );
}
