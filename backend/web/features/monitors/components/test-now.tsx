/* "Test now": runs the check from every selected region and shows each result as it arrives. */
"use client";

import { useRegionLabel } from "@/features/settings/private-probes";
import * as React from "react";
import { useTranslations } from "next-intl";
import { FlaskConical } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { monitorsApi, type ProbeTaskView } from "../api";

const POLL_MS = 1_000;
const GIVE_UP_MS = 45_000;

export function TestNow({ ws, monitorId }: { ws: string; monitorId: string }) {
  const regionLabel = useRegionLabel(ws);
  const t = useTranslations("monitors");
  const [tasks, setTasks] = React.useState<ProbeTaskView[] | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      let current = (await monitorsApi.testNow(ws, monitorId)).data;
      setTasks(current);
      const deadline = Date.now() + GIVE_UP_MS;
      while (current.some((task) => task.status === "pending" || task.status === "running")) {
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
        current = await Promise.all(current.map((task) => monitorsApi.task(ws, task.id)));
        setTasks(current);
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="grid gap-2">
      <div>
        <Button variant="outline" onClick={run} disabled={running}>
          <FlaskConical aria-hidden />
          {running ? t("testing") : t("testNow")}
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {tasks && (
        <ul className="grid gap-1 text-sm" aria-live="polite">
          {tasks.map((task) => (
            <li key={task.id}>
              {task.result
                ? t("testResult", {
                    region: regionLabel(task.region),
                    outcome: task.result.ok
                      ? t("testOk")
                      : `${t("testFailed")} (${task.result.errorCode ?? "?"})`,
                    ms: Math.round(task.result.latencyMs ?? 0),
                  })
                : t("testPending", { region: regionLabel(task.region) })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
