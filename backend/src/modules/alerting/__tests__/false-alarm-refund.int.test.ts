/*
 * PRODUCT.md §5: marking an incident as a false alarm returns the SMS and voice credits its alerts
 * used. The alerting module consumes `incident.false_alarm_marked` and asks credits for the refund;
 * the event can be delivered twice and must refund once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeClock } from "../../../core/clock.js";
import { createWorkspaceScope } from "../../../core/workspace-scope.js";
import { newId } from "../../../infra/ids.js";
import {
  buildBillingApp,
  fakePaddleApi,
  PRICES,
  signUpWithWorkspace,
  subscribeWorkspace,
  type BillingApp,
} from "../../../__tests__/helpers/billing.js";
import type { AlertingService } from "../alerting.service.js";
import { createAlertingEventHandlers } from "../events/index.js";

const clock = createFakeClock(new Date());
const paddle = fakePaddleApi(clock);
let ctx: BillingApp;

beforeAll(() => {
  ctx = buildBillingApp(clock, paddle);
});

afterAll(async () => {
  await ctx.container.close();
});

describe("false-alarm credit refunds", () => {
  it("gives back the credits an incident's alerts used, once", async () => {
    const owner = await signUpWithWorkspace(ctx, "fa-refund");
    const scope = createWorkspaceScope({ workspaceId: owner.workspaceId });
    const credits = ctx.credits.service;
    await subscribeWorkspace(ctx, paddle, clock, owner, {
      priceId: PRICES.starterMonth,
      plan: "starter",
    });
    await credits.grantDue(owner.workspaceId);

    const incidentId = newId();
    await credits.charge(scope, { credits: 2, refId: "sms-1", incidentId });
    await credits.charge(scope, { credits: 4, refId: "voice-1", incidentId });
    await credits.charge(scope, { credits: 1, refId: "sms-other", incidentId: newId() });
    expect((await credits.state(scope)).total).toBe(18);

    /* The handler only needs credits for this event; the alerting service isn't touched. */
    const handle = createAlertingEventHandlers({} as AlertingService, credits)[
      "incident.false_alarm_marked"
    ];
    if (handle === undefined) throw new Error("no false-alarm handler");
    const meta = {
      eventId: newId(),
      workspaceId: owner.workspaceId,
      correlationId: null,
      logger: ctx.container.infra.logger,
    };
    await handle({ incidentId }, meta);
    expect((await credits.state(scope)).total).toBe(24);
    await handle({ incidentId }, meta);
    expect((await credits.state(scope)).total).toBe(24);
  });

  it("does nothing when alerting runs without the credits module", async () => {
    const handle = createAlertingEventHandlers({} as AlertingService)[
      "incident.false_alarm_marked"
    ];
    await expect(
      handle?.(
        { incidentId: newId() },
        {
          eventId: newId(),
          workspaceId: newId(),
          correlationId: null,
          logger: ctx.container.infra.logger,
        },
      ),
    ).resolves.toBeUndefined();
  });
});
