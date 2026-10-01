/*
 * Better Auth (STACK.md §2): email/password with verification, magic links, TOTP 2FA,
 * organizations as workspaces, Turnstile on sign-up, Redis-backed rate limits.
 * Better Auth owns its tables (schema.ts); modules reach users and memberships through `workspaces`.
 * Its callbacks run outside our transactions, so emails go through `requestEmail`
 * (an outbox event in its own transaction).
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { captcha, magicLink, organization, twoFactor } from "better-auth/plugins";
import type { Db } from "../db/index.js";
import { newId } from "../ids.js";
import { accessControl, workspaceRoles } from "./access.js";
import type { RateLimitDecision } from "./rate-limit-storage.js";
import * as authSchema from "./schema.js";

export type AuthEmailTemplate = "verify-email" | "magic-link" | "reset-password" | "invite";

export interface AuthOptions {
  db: Db;
  /* Public base URL of the API (links in emails point here). */
  baseURL: string;
  secret: string;
  /* The web app origin: trusted for cookies/CSRF and used for invitation links. */
  webOrigin: string;
  requestEmail: (
    template: AuthEmailTemplate,
    to: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  /* Redis storage for rate limits, or false to disable (tests). */
  rateLimit:
    | false
    | { consume(key: string, rule: { window: number; max: number }): Promise<RateLimitDecision> };
  /* Cloudflare Turnstile on sign-up; omitted only outside production. */
  turnstile?: { secretKey: string; siteVerifyURLOverride?: string };
  /*
   * Called after Better Auth commits a new organization (workspace). Must be idempotent; a recovery
   * sweep covers a crash before it runs. Late-bound because modules are created after infra.
   */
  onWorkspaceCreated?: (workspaceId: string) => Promise<void>;
  /*
   * How many members a workspace may have on its plan (PRODUCT.md §5). Late-bound like the hook above;
   * `undefined` (no billing module, or it isn't wired yet) falls back to DEFAULT_MEMBER_LIMIT.
   */
  memberLimit?: (workspaceId: string) => Promise<number | undefined> | undefined;
}

export const DEFAULT_MEMBER_LIMIT = 100;

export const AUTH_BASE_PATH = "/api/auth";
export const INVITATION_EXPIRES_SECONDS = 48 * 3_600;

export function createAuth(options: AuthOptions) {
  const { requestEmail } = options;
  return betterAuth({
    appName: "Watchpost",
    baseURL: options.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
    trustedOrigins: [options.webOrigin],
    database: drizzleAdapter(options.db, { provider: "pg", schema: authSchema }),
    advanced: {
      cookiePrefix: "watchpost",
      database: { generateId: () => newId() },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      sendResetPassword: async ({ user, url }) => {
        await requestEmail("reset-password", user.email, { url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 24 * 3_600,
      sendVerificationEmail: async ({ user, url }) => {
        await requestEmail("verify-email", user.email, { url, name: user.name });
      },
    },
    rateLimit:
      options.rateLimit === false
        ? { enabled: false }
        : { enabled: true, window: 60, max: 100, customStorage: options.rateLimit },
    plugins: [
      ...(options.turnstile
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: options.turnstile.secretKey,
              endpoints: ["/sign-up/email"],
              ...(options.turnstile.siteVerifyURLOverride
                ? { siteVerifyURLOverride: options.turnstile.siteVerifyURLOverride }
                : {}),
            }),
          ]
        : []),
      organization({
        ac: accessControl,
        roles: workspaceRoles,
        creatorRole: "owner",
        allowUserToCreateOrganization: true,
        membershipLimit: async (_user, organization) =>
          (await options.memberLimit?.(organization.id)) ?? DEFAULT_MEMBER_LIMIT,
        requireEmailVerificationOnInvitation: true,
        invitationExpiresIn: INVITATION_EXPIRES_SECONDS,
        organizationHooks: {
          afterCreateOrganization: async ({ organization }) => {
            await options.onWorkspaceCreated?.(organization.id);
          },
        },
        sendInvitationEmail: async (data) => {
          await requestEmail("invite", data.email, {
            url: `${options.webOrigin}/invite/${data.id}`,
            workspaceName: data.organization.name,
            inviterName: data.inviter.user.name || data.inviter.user.email,
            role: data.role,
          });
        },
      }),
      twoFactor({ issuer: "Watchpost" }),
      magicLink({
        expiresIn: 300,
        sendMagicLink: async ({ email, url }) => {
          await requestEmail("magic-link", email, { url });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
