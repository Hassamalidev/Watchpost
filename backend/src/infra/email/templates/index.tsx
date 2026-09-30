/*
 * Transactional email templates (PRODUCT.md §10). Each one has a data schema (producers put this data
 * in `email.requested`), a subject and a React Email component; `renderEmail` produces HTML and the
 * plain-text version from the same component.
 */
import type { ReactElement } from "react";
import { Button, Heading, Hr, Link, Section, Text } from "@react-email/components";
import { render } from "@react-email/components";
import { z } from "zod";
import { EmailLayout, styles, type Tone } from "./layout.js";

const url = z.url();

function Action({ href, children }: { href: string; children: string }) {
  return (
    <Section style={{ margin: "20px 0" }}>
      <Button className="wp-button" href={href} style={styles.button}>
        {children}
      </Button>
    </Section>
  );
}

function Fallback({ href }: { href: string }) {
  return (
    <Text className="wp-muted" style={styles.muted}>
      Or open this link: <Link href={href}>{href}</Link>
    </Text>
  );
}

const alertKinds = [
  "triggered",
  "acknowledged",
  "resolved",
  "reminder",
  "flapping",
  "test",
] as const;

const alertData = z.object({
  kind: z.enum(alertKinds),
  subject: z.string().min(1).max(300),
  workspaceName: z.string(),
  incident: z.object({
    number: z.number().int(),
    title: z.string(),
    severity: z.enum(["critical", "high", "low"]),
    causeCode: z.string().nullable(),
    failingRegions: z.array(z.string()),
    monitorName: z.string().nullable(),
    startedAt: z.string(),
    durationSeconds: z.number().int(),
    url,
  }),
  actor: z.string().nullable().default(null),
  /* Signed, single-use links for this recipient (acknowledge while triggered, resolve while open). */
  actions: z.object({ acknowledge: url.optional(), resolve: url.optional() }).default({}),
});

const ALERT_HEADLINE: Record<(typeof alertKinds)[number], { label: string; tone: Tone }> = {
  triggered: { label: "Down", tone: "down" },
  reminder: { label: "Still down", tone: "down" },
  flapping: { label: "Flapping", tone: "warn" },
  acknowledged: { label: "Acknowledged", tone: "warn" },
  resolved: { label: "Resolved", tone: "up" },
  test: { label: "Test alert", tone: "neutral" },
};

function minutes(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function AlertEmail(d: z.infer<typeof alertData>) {
  const headline = ALERT_HEADLINE[d.kind];
  const { incident } = d;
  const facts = [
    incident.monitorName ? ["Monitor", incident.monitorName] : null,
    ["Severity", incident.severity],
    incident.causeCode ? ["Cause", incident.causeCode] : null,
    incident.failingRegions.length > 0
      ? ["Failing regions", incident.failingRegions.join(", ")]
      : null,
    ["Started", new Date(incident.startedAt).toUTCString()],
    d.kind === "resolved" ? ["Duration", minutes(incident.durationSeconds)] : null,
    d.actor ? ["By", d.actor] : null,
  ].filter((f): f is [string, string] => f !== null);
  return (
    <EmailLayout
      preview={d.subject}
      footer={`Alert from the ${d.workspaceName} workspace on Watchpost.`}
    >
      <Text
        className={`wp-${headline.tone === "neutral" ? "text" : headline.tone}`}
        style={{
          ...styles.text,
          ...styles.tone[headline.tone],
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {headline.label}
      </Text>
      <Heading as="h1" className="wp-text" style={styles.heading}>
        {d.kind === "test" ? "This channel works" : `#${incident.number} ${incident.title}`}
      </Heading>
      {d.kind === "test" ? (
        <Text className="wp-text" style={styles.text}>
          This is a test alert for {d.workspaceName}. Real alerts to this address look like this
          one.
        </Text>
      ) : (
        facts.map(([label, value]) => (
          <Text key={label} className="wp-text" style={{ ...styles.text, margin: "0 0 4px" }}>
            <strong>{label}:</strong> {value}
          </Text>
        ))
      )}
      {d.actions.acknowledge && <Action href={d.actions.acknowledge}>Acknowledge</Action>}
      {d.actions.resolve && (
        <Text className="wp-text" style={styles.text}>
          <Link href={d.actions.resolve}>Resolve the incident</Link>
        </Text>
      )}
      {d.kind !== "test" && (
        <Text className="wp-text" style={styles.text}>
          <Link href={incident.url}>Open the incident in Watchpost</Link>
        </Text>
      )}
      {(d.actions.acknowledge || d.actions.resolve) && (
        <Text className="wp-muted" style={styles.muted}>
          Action links work once, for 24 hours, and only for you.
        </Text>
      )}
    </EmailLayout>
  );
}

const digestData = z.object({
  workspaceName: z.string(),
  weekStart: z.string(),
  weekEnd: z.string(),
  incidents: z.number().int(),
  resolved: z.number().int(),
  mttrMinutes: z.number().nullable(),
  monitors: z.array(
    z.object({
      name: z.string(),
      uptimePercent: z.number().nullable(),
      downtimeMinutes: z.number(),
    }),
  ),
  totalMonitors: z.number().int(),
  url,
  settingsUrl: url,
});

function DigestEmail(d: z.infer<typeof digestData>) {
  return (
    <EmailLayout
      preview={`${d.workspaceName}: ${d.incidents} incident${d.incidents === 1 ? "" : "s"} this week`}
      footer="Weekly digest from Watchpost. Change who receives it in the workspace settings."
    >
      <Heading as="h1" className="wp-text" style={styles.heading}>
        Your week in {d.workspaceName}
      </Heading>
      <Text className="wp-muted" style={styles.muted}>
        {d.weekStart} – {d.weekEnd}
      </Text>
      <Text className="wp-text" style={styles.text}>
        {d.incidents === 0
          ? `No incidents across ${d.totalMonitors} monitors. A quiet week.`
          : `${d.incidents} incident${d.incidents === 1 ? "" : "s"}, ${d.resolved} resolved${d.mttrMinutes === null ? "" : `, ${Math.round(d.mttrMinutes)} min to resolve on average`}.`}
      </Text>
      {d.monitors.length > 0 && (
        <>
          <Hr />
          <Text className="wp-text" style={{ ...styles.text, fontWeight: 600 }}>
            Most downtime
          </Text>
          {d.monitors.map((m) => (
            <Text key={m.name} className="wp-text" style={{ ...styles.text, margin: "0 0 4px" }}>
              {m.name}: {m.uptimePercent === null ? "—" : `${m.uptimePercent.toFixed(3)}% up`} ·{" "}
              {Math.round(m.downtimeMinutes)} min down
            </Text>
          ))}
        </>
      )}
      <Action href={d.url}>Open Watchpost</Action>
      <Text className="wp-muted" style={styles.muted}>
        <Link href={d.settingsUrl}>Email settings</Link>
      </Text>
    </EmailLayout>
  );
}

export const EMAIL_TEMPLATES = {
  "verify-email": {
    data: z.object({ url, name: z.string().optional() }),
    subject: () => "Verify your email for Watchpost",
    component: (d: { url: string; name?: string | undefined }) => (
      <EmailLayout preview="Confirm your email to finish setting up Watchpost">
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Confirm your email
        </Heading>
        <Text className="wp-text" style={styles.text}>
          Hi{d.name ? ` ${d.name}` : ""}, confirm your email address to finish setting up Watchpost.
        </Text>
        <Action href={d.url}>Confirm email</Action>
        <Fallback href={d.url} />
        <Text className="wp-muted" style={styles.muted}>
          The link expires in 24 hours. If you didn&apos;t sign up, ignore this email.
        </Text>
      </EmailLayout>
    ),
  },
  "magic-link": {
    data: z.object({ url }),
    subject: () => "Your Watchpost sign-in link",
    component: (d: { url: string }) => (
      <EmailLayout preview="Sign in to Watchpost">
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Sign in to Watchpost
        </Heading>
        <Action href={d.url}>Sign in</Action>
        <Fallback href={d.url} />
        <Text className="wp-muted" style={styles.muted}>
          It expires in 5 minutes and works once. If you didn&apos;t ask for it, ignore this email.
        </Text>
      </EmailLayout>
    ),
  },
  "reset-password": {
    data: z.object({ url }),
    subject: () => "Reset your Watchpost password",
    component: (d: { url: string }) => (
      <EmailLayout preview="Reset your Watchpost password">
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Reset your password
        </Heading>
        <Text className="wp-text" style={styles.text}>
          Someone asked to reset the password for this Watchpost account.
        </Text>
        <Action href={d.url}>Choose a new password</Action>
        <Fallback href={d.url} />
        <Text className="wp-muted" style={styles.muted}>
          If it wasn&apos;t you, ignore this email; your password stays the same.
        </Text>
      </EmailLayout>
    ),
  },
  invite: {
    data: z.object({ url, workspaceName: z.string(), inviterName: z.string(), role: z.string() }),
    subject: (d: { workspaceName: string; inviterName: string }) =>
      `${d.inviterName} invited you to ${d.workspaceName} on Watchpost`,
    component: (d: { url: string; workspaceName: string; inviterName: string; role: string }) => (
      <EmailLayout preview={`Join ${d.workspaceName} on Watchpost`}>
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Join {d.workspaceName}
        </Heading>
        <Text className="wp-text" style={styles.text}>
          {d.inviterName} invited you to the &quot;{d.workspaceName}&quot; workspace on Watchpost as{" "}
          {d.role}.
        </Text>
        <Action href={d.url}>Accept the invitation</Action>
        <Fallback href={d.url} />
        <Text className="wp-muted" style={styles.muted}>
          The invitation expires in 48 hours.
        </Text>
      </EmailLayout>
    ),
  },
  alert: {
    data: alertData,
    subject: (d: { subject: string }) => d.subject,
    component: AlertEmail,
  },
  "channel-failing": {
    data: z.object({
      workspaceName: z.string(),
      channelName: z.string(),
      channelType: z.string(),
      error: z.string(),
      url,
      incidentTitle: z.string().optional(),
    }),
    subject: (d: { channelName: string; workspaceName: string }) =>
      `Alert channel "${d.channelName}" is failing in ${d.workspaceName}`,
    component: (d: {
      workspaceName: string;
      channelName: string;
      channelType: string;
      error: string;
      url: string;
      incidentTitle?: string | undefined;
    }) => (
      <EmailLayout
        preview={`Alerts aren't reaching ${d.channelName}`}
        footer="You get this email at most once an hour while channels keep failing."
      >
        <Text className="wp-down" style={{ ...styles.text, ...styles.tone.down, fontWeight: 700 }}>
          Channel failing
        </Text>
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Alerts aren&apos;t reaching &quot;{d.channelName}&quot;
        </Heading>
        <Text className="wp-text" style={styles.text}>
          Watchpost couldn&apos;t deliver alerts to the {d.channelType} channel &quot;
          {d.channelName}
          &quot; in {d.workspaceName}. Last error: {d.error}
        </Text>
        {d.incidentTitle && (
          <Text className="wp-text" style={styles.text}>
            Undelivered alert: {d.incidentTitle}
          </Text>
        )}
        <Action href={d.url}>Check the channel</Action>
      </EmailLayout>
    ),
  },
  digest: {
    data: digestData,
    subject: (d: { workspaceName: string; incidents: number }) =>
      `${d.workspaceName} weekly digest: ${d.incidents} incident${d.incidents === 1 ? "" : "s"}`,
    component: DigestEmail,
  },
} as const;

export type EmailTemplate = keyof typeof EMAIL_TEMPLATES;

export function isEmailTemplate(value: string): value is EmailTemplate {
  return Object.hasOwn(EMAIL_TEMPLATES, value);
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export async function renderEmail(template: string, data: unknown): Promise<RenderedEmail> {
  if (!isEmailTemplate(template)) throw new Error(`Unknown email template "${template}"`);
  const definition = EMAIL_TEMPLATES[template];
  const parsed = definition.data.parse(data) as never;
  const element = (definition.component as (d: never) => ReactElement)(parsed);
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return {
    subject: (definition.subject as (d: never) => string)(parsed),
    html,
    text,
  };
}
