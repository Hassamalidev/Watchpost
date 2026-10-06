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
  /* Plain-language cause and first checks from the failure explainer. */
  explanation: z
    .object({ headline: z.string(), detail: z.string(), nextSteps: z.array(z.string()) })
    .nullable()
    .default(null),
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
      {d.explanation && (
        <Section style={{ borderLeft: "3px solid #a3a3a3", paddingLeft: "12px", margin: "16px 0" }}>
          <Text className="wp-text" style={{ ...styles.text, fontWeight: 600, margin: "0 0 4px" }}>
            Likely cause: {d.explanation.headline}
          </Text>
          <Text className="wp-muted" style={{ ...styles.muted, fontSize: "14px" }}>
            {d.explanation.detail}
          </Text>
          {d.explanation.nextSteps.map((step) => (
            <Text key={step} className="wp-text" style={{ ...styles.text, margin: "0 0 4px" }}>
              → {step}
            </Text>
          ))}
        </Section>
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

export const BILLING_EMAIL_KINDS = [
  "trial_started",
  "trial_midway",
  "trial_ending",
  "trial_ended",
  "payment_failed",
  "subscription_started",
  "subscription_canceled",
  "credits_low",
] as const;
export type BillingEmailKind = (typeof BILLING_EMAIL_KINDS)[number];

const billingData = z.object({
  kind: z.enum(BILLING_EMAIL_KINDS),
  workspaceName: z.string(),
  /* The workspace's billing page. */
  url,
  planName: z.string().optional(),
  /* A date already written for people ("14 October 2026"): trial end, grace end or period end. */
  date: z.string().optional(),
  daysLeft: z.number().int().optional(),
  credits: z.number().int().optional(),
});
type BillingData = z.infer<typeof billingData>;

interface BillingCopy {
  subject: string;
  heading: string;
  lines: string[];
  action: string;
  tone: Tone;
}

/* One place for billing wording, so every email says what happens next and what to do about it. */
export function billingCopy(d: BillingData): BillingCopy {
  const plan = d.planName ?? "Pro";
  const date = d.date ?? "soon";
  switch (d.kind) {
    case "trial_started":
      return {
        subject: `Your 14-day ${plan} trial of Watchpost has started`,
        heading: `${d.workspaceName} is on the ${plan} plan for 14 days`,
        lines: [
          `No card needed. Until ${date} you have faster checks, more regions and more monitors.`,
          "When the trial ends the workspace moves to the Free plan unless you pick a plan. Nothing is deleted.",
        ],
        action: "See plans",
        tone: "neutral",
      };
    case "trial_midway":
      return {
        subject: `${d.daysLeft ?? 7} days left in your Watchpost trial`,
        heading: `Your ${plan} trial is halfway through`,
        lines: [
          `The trial for ${d.workspaceName} ends on ${date}.`,
          "Pick a plan any time to keep what you set up. On Free, monitors over the limit are paused, never deleted.",
        ],
        action: "Compare plans",
        tone: "neutral",
      };
    case "trial_ending":
      return {
        subject: `Your Watchpost trial ends in ${d.daysLeft ?? 2} days`,
        heading: `The ${plan} trial ends on ${date}`,
        lines: [
          `After that ${d.workspaceName} moves to the Free plan: 20 monitors, checks every 3 minutes, 2 regions.`,
          "Monitors over the limit are paused and faster checks slow down. Your data stays.",
        ],
        action: "Keep your plan",
        tone: "warn",
      };
    case "trial_ended":
      return {
        subject: `Your Watchpost trial has ended`,
        heading: `${d.workspaceName} is now on the Free plan`,
        lines: [
          "Monitors over the Free limit are paused and checks faster than 3 minutes were slowed down. Nothing was deleted.",
          "Upgrade to resume them; you choose which monitors stay active.",
        ],
        action: "Upgrade",
        tone: "warn",
      };
    case "payment_failed":
      return {
        subject: `Payment failed for ${d.workspaceName} on Watchpost`,
        heading: "We couldn't take your payment",
        lines: [
          `The ${plan} plan stays on until ${date} while the payment is retried.`,
          "Update the payment method to keep paid features. After that date the workspace moves to Free and monitors over the limit are paused.",
        ],
        action: "Update payment method",
        tone: "down",
      };
    case "subscription_started":
      return {
        subject: `${d.workspaceName} is now on Watchpost ${plan}`,
        heading: `Welcome to ${plan}`,
        lines: [
          `Your subscription is active. It renews on ${date}.`,
          "Invoices, payment method and cancellation are on the billing page.",
        ],
        action: "Open billing",
        tone: "up",
      };
    case "subscription_canceled":
      return {
        subject: `Your Watchpost subscription has ended`,
        heading: `${d.workspaceName} is now on the Free plan`,
        lines: [
          "Monitors over the Free limit are paused, never deleted. Unused purchased credits stay in the workspace.",
          "You can subscribe again any time.",
        ],
        action: "Open billing",
        tone: "neutral",
      };
    case "credits_low":
      return {
        subject: `${d.workspaceName} has ${d.credits ?? 0} SMS and voice credits left`,
        heading: "Credits are running low",
        lines: [
          `${d.credits ?? 0} credits are left. When they run out, SMS and voice alerts stop; email and chat alerts keep working.`,
          "Buy a credit pack to keep phone alerts on.",
        ],
        action: "Buy credits",
        tone: "warn",
      };
  }
}

function BillingEmail(d: BillingData) {
  const copy = billingCopy(d);
  return (
    <EmailLayout preview={copy.heading}>
      <Heading
        as="h1"
        className={copy.tone === "neutral" ? "wp-text" : `wp-${copy.tone}`}
        style={{ ...styles.heading, ...styles.tone[copy.tone] }}
      >
        {copy.heading}
      </Heading>
      {copy.lines.map((line) => (
        <Text key={line} className="wp-text" style={styles.text}>
          {line}
        </Text>
      ))}
      <Action href={d.url}>{copy.action}</Action>
      <Fallback href={d.url} />
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
  "contact-code": {
    data: z.object({ code: z.string().regex(/^\d{6}$/), workspaceName: z.string() }),
    subject: (d: { code: string }) => `${d.code} is your Watchpost code`,
    component: (d: { code: string; workspaceName: string }) => (
      <EmailLayout
        preview={`Your code is ${d.code}`}
        footer="You get this email because someone added this address as a contact method."
      >
        <Heading as="h1" className="wp-text" style={styles.heading}>
          Confirm this address for alerts
        </Heading>
        <Text className="wp-text" style={styles.text}>
          Enter this code in Watchpost to get {d.workspaceName} alerts at this address:
        </Text>
        <Text
          className="wp-text"
          style={{ ...styles.text, fontSize: "28px", fontWeight: 700, letterSpacing: "4px" }}
        >
          {d.code}
        </Text>
        <Text className="wp-muted" style={styles.muted}>
          The code expires in 10 minutes. If you didn&apos;t ask for it, ignore this email and
          nothing will be sent here.
        </Text>
      </EmailLayout>
    ),
  },
  "shift-notice": {
    data: z.object({
      kind: z.enum(["start", "end"]),
      scheduleName: z.string(),
      workspaceName: z.string(),
      timezone: z.string(),
      at: z.iso.datetime({ offset: true }),
      until: z.iso.datetime({ offset: true }).optional(),
      otherName: z.string().optional(),
      url,
    }),
    subject: (d: { kind: "start" | "end"; scheduleName: string }) =>
      d.kind === "start"
        ? `You are on call for ${d.scheduleName}`
        : `Your on-call shift for ${d.scheduleName} has ended`,
    component: (d: {
      kind: "start" | "end";
      scheduleName: string;
      workspaceName: string;
      timezone: string;
      at: string;
      until?: string | undefined;
      otherName?: string | undefined;
      url: string;
    }) => {
      const when = (iso: string) =>
        `${new Intl.DateTimeFormat("en", {
          timeZone: d.timezone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(iso))} (${d.timezone})`;
      return (
        <EmailLayout
          preview={
            d.kind === "start"
              ? `Your shift for ${d.scheduleName} has started`
              : `Your shift for ${d.scheduleName} has ended`
          }
          footer="You get this email because you are on an on-call schedule. Change where it goes under My notifications."
        >
          <Heading as="h1" className="wp-text" style={styles.heading}>
            {d.kind === "start" ? "You are on call" : "Your shift has ended"}
          </Heading>
          <Text className="wp-text" style={styles.text}>
            {d.kind === "start"
              ? `Your shift for ${d.scheduleName} in ${d.workspaceName} started at ${when(d.at)}.`
              : `Your shift for ${d.scheduleName} in ${d.workspaceName} ended at ${when(d.at)}.`}
          </Text>
          {d.kind === "start" && d.until !== undefined && (
            <Text className="wp-text" style={styles.text}>
              It runs until {when(d.until)}.
            </Text>
          )}
          {d.otherName !== undefined && (
            <Text className="wp-text" style={styles.text}>
              {d.kind === "start"
                ? `You took over from ${d.otherName}.`
                : `${d.otherName} is on call now.`}
            </Text>
          )}
          <Action href={d.url}>Open the schedule</Action>
          <Fallback href={d.url} />
        </EmailLayout>
      );
    },
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
  /* Notices to the people who run the platform (provider balances), never to customers. */
  "ops-notice": {
    data: z.object({
      subject: z.string().min(1).max(200),
      heading: z.string().min(1).max(200),
      lines: z.array(z.string().max(1_000)).min(1).max(10),
    }),
    subject: (d: { subject: string }) => `[Watchpost ops] ${d.subject}`,
    component: (d: { heading: string; lines: string[] }) => (
      <EmailLayout preview={d.heading} footer="You get this email because OPS_EMAIL points here.">
        <Heading as="h1" className="wp-warn" style={{ ...styles.heading, ...styles.tone.warn }}>
          {d.heading}
        </Heading>
        {d.lines.map((line) => (
          <Text key={line} className="wp-text" style={styles.text}>
            {line}
          </Text>
        ))}
      </EmailLayout>
    ),
  },
  billing: {
    data: billingData,
    subject: (d: BillingData) => billingCopy(d).subject,
    component: BillingEmail,
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
