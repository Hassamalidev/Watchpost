import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { AppError } from "../../core/errors.js";
import { createWorkspaceScope } from "../../core/workspace-scope.js";
import { createQuotaGuard } from "../quota.js";

const scope = createWorkspaceScope({ workspaceId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });

async function run(hasFeature: boolean, locals: object = { scope }) {
  const lookup = vi.fn(async () => hasFeature);
  const guard = createQuotaGuard(lookup)("sso", "Single sign-on needs the Business plan.");
  const next = vi.fn();
  await guard({} as Request, { locals } as unknown as Response, next);
  return { next, lookup };
}

describe("requireFeature", () => {
  it("lets the request through when the plan has the feature", async () => {
    const { next, lookup } = await run(true);
    expect(lookup).toHaveBeenCalledWith(scope, "sso");
    expect(next).toHaveBeenCalledWith();
  });

  it("answers 402 quota_exceeded with the upgrade message when it doesn't", async () => {
    const { next } = await run(false);
    const err = next.mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      status: 402,
      code: "quota_exceeded",
      message: "Single sign-on needs the Business plan.",
    });
  });

  it("answers 404 without a workspace scope", async () => {
    const { next, lookup } = await run(true, {});
    expect((next.mock.calls[0]?.[0] as AppError).status).toBe(404);
    expect(lookup).not.toHaveBeenCalled();
  });
});
