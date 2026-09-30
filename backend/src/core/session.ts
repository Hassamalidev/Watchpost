/* The signed-in user as seen by our code, independent of the auth library. */
import type { IncomingHttpHeaders } from "node:http";

export interface SessionContext {
  userId: string;
  email: string;
  emailVerified: boolean;
  sessionId: string;
}

export type GetSession = (headers: IncomingHttpHeaders) => Promise<SessionContext | null>;
