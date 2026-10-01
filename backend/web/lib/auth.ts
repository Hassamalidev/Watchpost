/* Better Auth endpoints the web app uses (email + password, sessions, workspaces as organizations). */
import { api } from "@/lib/api";

export interface Session {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: { activeOrganizationId?: string | null };
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
}

export const getSession = () => api<Session | null>("/api/auth/get-session");

/* `next` brings the confirmation link back to where sign-up started (an invitation). */
export const signUp = (
  input: { name: string; email: string; password: string },
  next: string = "/onboarding",
) =>
  api<unknown>("/api/auth/sign-up/email", {
    method: "POST",
    body: { ...input, callbackURL: `${window.location.origin}${next}` },
  });

export const signIn = (input: { email: string; password: string }) =>
  api<unknown>("/api/auth/sign-in/email", { method: "POST", body: input });

export const signOut = () => api<unknown>("/api/auth/sign-out", { method: "POST", body: {} });

export const listWorkspaces = () => api<Workspace[]>("/api/auth/organization/list");

export const createWorkspace = (name: string) =>
  api<Workspace>("/api/auth/organization/create", {
    method: "POST",
    body: {
      name,
      slug: `${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`,
    },
  });

export interface InvitationView {
  id: string;
  email: string;
  role: string;
  status: "pending" | "accepted" | "rejected" | "canceled";
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
}

export const getInvitation = (id: string) =>
  api<InvitationView>(`/api/auth/organization/get-invitation?id=${encodeURIComponent(id)}`);

export const acceptInvitation = (invitationId: string) =>
  api<unknown>("/api/auth/organization/accept-invitation", {
    method: "POST",
    body: { invitationId },
  });

export const rejectInvitation = (invitationId: string) =>
  api<unknown>("/api/auth/organization/reject-invitation", {
    method: "POST",
    body: { invitationId },
  });

export const inviteMember = (
  workspaceId: string,
  email: string,
  role: "admin" | "member" | "viewer",
) =>
  api<unknown>("/api/auth/organization/invite-member", {
    method: "POST",
    body: { email, role, organizationId: workspaceId },
  });
