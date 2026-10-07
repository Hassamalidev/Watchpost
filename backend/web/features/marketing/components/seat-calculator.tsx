/* Per-seat calculator: what a team pays on per-user tools next to the flat Pro plan. */
"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  CHECKED_ON,
  FLAT_PRO_MONTHLY,
  MAX_TEAM_SIZE,
  PER_SEAT_TOOLS,
  compareSeatCost,
} from "@/features/marketing/competitors";

const usd = (amount: number) => `$${amount.toLocaleString("en-US")}`;

export function SeatCalculator() {
  const t = useTranslations("marketing");
  const [teamSize, setTeamSize] = React.useState(8);
  const rows = compareSeatCost(teamSize);

  return (
    <div className="grid gap-4">
      <div className="max-w-xs">
        <Field label={t("calculatorTeamSize")} htmlFor="team-size">
          <Input
            id="team-size"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_TEAM_SIZE}
            value={teamSize}
            onChange={(event) => setTeamSize(Number(event.target.value))}
          />
        </Field>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" aria-live="polite">
          <thead className="bg-muted/60 text-left">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("calculatorTool")}
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("calculatorMonthly")}
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                {t("calculatorDifference")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t font-medium">
              <th scope="row" className="px-4 py-2 text-left">
                UptimeWatch Pro
                <span className="block text-xs font-normal text-muted-foreground">
                  {t("calculatorFlat")}
                </span>
              </th>
              <td className="px-4 py-2">{usd(FLAT_PRO_MONTHLY)}</td>
              <td className="px-4 py-2 text-muted-foreground">—</td>
            </tr>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-t">
                <th scope="row" className="px-4 py-2 text-left font-normal">
                  {row.name}
                  <span className="block text-xs text-muted-foreground">
                    {t("calculatorPerSeat", { price: usd(PER_SEAT_TOOLS[index]?.perSeat ?? 0) })}
                  </span>
                </th>
                <td className="px-4 py-2">{usd(row.monthly)}</td>
                <td className="px-4 py-2">
                  {row.yearlyDifference > 0 ? usd(row.yearlyDifference) : t("calculatorSame")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t("calculatorNote", { date: CHECKED_ON })}</p>
    </div>
  );
}
