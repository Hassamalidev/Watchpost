/*
 * Plain-text transactional templates for auth emails. React Email versions replace these in P1-T18;
 * the template names and data shapes stay the same.
 */
import { z } from "zod";

const url = z.url();

export const EMAIL_TEMPLATES = {
  "verify-email": {
    data: z.object({ url, name: z.string().optional() }),
    render: (d: { url: string; name?: string | undefined }) => ({
      subject: "Verify your email for Watchpost",
      text: `Hi${d.name ? ` ${d.name}` : ""},\n\nConfirm your email address to finish setting up Watchpost:\n${d.url}\n\nThe link expires in 24 hours. If you didn't sign up, ignore this email.`,
    }),
  },
  "magic-link": {
    data: z.object({ url }),
    render: (d: { url: string }) => ({
      subject: "Your Watchpost sign-in link",
      text: `Use this link to sign in to Watchpost:\n${d.url}\n\nIt expires in 5 minutes and works once. If you didn't ask for it, ignore this email.`,
    }),
  },
  "reset-password": {
    data: z.object({ url }),
    render: (d: { url: string }) => ({
      subject: "Reset your Watchpost password",
      text: `Someone asked to reset the password for this Watchpost account.\n\nReset it here:\n${d.url}\n\nIf it wasn't you, ignore this email; your password stays the same.`,
    }),
  },
  invite: {
    data: z.object({ url, workspaceName: z.string(), inviterName: z.string(), role: z.string() }),
    render: (d: { url: string; workspaceName: string; inviterName: string; role: string }) => ({
      subject: `${d.inviterName} invited you to ${d.workspaceName} on Watchpost`,
      text: `${d.inviterName} invited you to join the "${d.workspaceName}" workspace on Watchpost as ${d.role}.\n\nAccept the invitation:\n${d.url}\n\nThe invitation expires in 48 hours.`,
    }),
  },
} as const;

export type EmailTemplate = keyof typeof EMAIL_TEMPLATES;

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(EMAIL_TEMPLATES, value);
}

export function renderEmail(template: string, data: unknown): { subject: string; text: string } {
  if (!isEmailTemplate(template)) throw new Error(`Unknown email template "${template}"`);
  const definition = EMAIL_TEMPLATES[template];
  const parsed = definition.data.parse(data);
  return (definition.render as (d: typeof parsed) => { subject: string; text: string })(parsed);
}
