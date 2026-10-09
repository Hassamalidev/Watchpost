/* The signed-in user as seen by our code, independent of the auth library. */
import type { IncomingHttpHeaders } from "node:http";

export interface SessionContext {
  userId: string;
  email: string;
  emailVerified: boolean;
  /* The account has a second sign-in step (TOTP) set up and confirmed. */
  twoFactorEnabled: boolean;
  sessionId: string;
}

export type GetSession = (headers: IncomingHttpHeaders) => Promise<SessionContext | null>;
