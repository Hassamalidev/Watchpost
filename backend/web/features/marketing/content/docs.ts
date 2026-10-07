/* The first docs pages: enough to get a team from sign-up to a trusted alert. */
import type { ContentPage } from "./types";

export const DOCS_PAGES: readonly ContentPage[] = [
  {
    slug: "migrate-from-opsgenie",
    title: "Moving from Opsgenie",
    summary:
      "Bring your schedules and escalation policies over, run both tools side by side, then switch.",
    sections: [
      {
        heading: "Before you start",
        list: [
          "Create your workspace and invite the people who are on call. People are matched by email address, so invite them with the address they use in Opsgenie.",
          "Give them the Responder role or higher: only people who can be paged can be put on a schedule.",
          "Ask everyone to open My notifications and check how they want to be reached: email is ready at once; they can add a phone number for texts and calls, and turn on notifications on their phone.",
        ],
      },
      {
        heading: "Export from Opsgenie",
        paragraphs: [
          "Use an Opsgenie API key that can read configuration (Settings, then API key management). These two requests return everything the importer reads. Use api.eu.opsgenie.com if your account is in the EU.",
        ],
        code: 'curl -s -H "Authorization: GenieKey $OPSGENIE_KEY" "https://api.opsgenie.com/v2/schedules?expand=rotation" > schedules.json\ncurl -s -H "Authorization: GenieKey $OPSGENIE_KEY" "https://api.opsgenie.com/v2/escalations" > escalations.json',
      },
      {
        heading: "Put the two answers together",
        paragraphs: [
          "The importer takes one JSON object with both lists. Each list is the data array from the matching answer. With jq:",
        ],
        code: "jq -n --slurpfile s schedules.json --slurpfile e escalations.json '{schedules: $s[0].data, escalations: $e[0].data}' > opsgenie.json",
      },
      {
        heading: "Preview, then import",
        list: [
          "Open Settings, then Import from another tool, and choose Opsgenie.",
          "Paste the contents of opsgenie.json and choose Preview. Nothing is created yet.",
          "The preview lists every schedule and escalation: what it becomes, and what can't come over with the reason. The usual reason is a person who isn't a member yet; invite them and preview again.",
          "Choose Import. Schedules are created first, then the escalation policies that page them.",
        ],
      },
      {
        heading: "What comes over, and how",
        list: [
          "Rotations become layers. Daily and weekly rotations keep their handoff time on the wall clock across daylight-saving changes; other lengths become a fixed number of hours.",
          "Escalation rules become steps. Opsgenie counts every delay from the start of the alert; UptimeWatch counts from the step before, so 0, 10 and 25 minutes become 0, then 10, then 15.",
          "A rule that notifies a schedule pages whoever is on call for the schedule imported under the same name.",
          "Not imported: teams, routing rules, heartbeats, integrations and notification rules of individual people. Set alert routes and integrations by hand; each person sets their own notification rules.",
        ],
      },
      {
        heading: "Run both side by side",
        paragraphs: [
          "You don't have to switch in one go. Add Opsgenie (or Jira Service Management) as an integration in UptimeWatch and every UptimeWatch alert also opens and closes an alert there, so your team keeps being paged the old way while you check that schedules and escalations here match.",
          "To send the alerts of your other tools to UptimeWatch, add an inbound source under Integrations (Prometheus Alertmanager, Grafana, Datadog, generic JSON or email) and point the tool at its URL.",
        ],
      },
      {
        heading: "Switch",
        list: [
          "On the on-call page, choose the escalation policy that alerts page through.",
          "Start an alert drill from Integrations and check that the right person is paged, and that the next step follows when nobody acknowledges.",
          "Remove the Opsgenie integration when you no longer need alerts there.",
        ],
      },
    ],
  },
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "From sign-up to your first delivered test alert in a few minutes.",
    sections: [
      {
        heading: "Create your account",
        paragraphs: [
          "Sign up with your work email and open the confirmation link we send you. No card is needed. Every new workspace starts with a 14-day Pro trial and moves to the Free plan afterwards unless you upgrade.",
        ],
      },
      {
        heading: "Set up your first monitors",
        list: [
          "Name your workspace, usually after your company or team.",
          "Paste the address of your site or API. UptimeWatch suggests monitors for the homepage, a health endpoint, the SSL certificate and the domain's expiry date.",
          "Choose where alerts go. Email works straight away; chat tools and webhooks can be added under Integrations.",
          "Send a test alert and check that it arrives.",
        ],
      },
      {
        heading: "Invite your team",
        paragraphs: [
          "Open Team in the sidebar and invite people by email. Owners and admins can change settings; members can acknowledge and resolve incidents; viewers can only read.",
        ],
      },
    ],
  },
  {
    slug: "monitors",
    title: "Monitors",
    summary: "What UptimeWatch can check and how it decides something is down.",
    sections: [
      {
        heading: "Monitor types",
        list: [
          "HTTP: the address answers with an expected status code in time.",
          "Keyword: the response contains (or does not contain) a piece of text.",
          "JSON query: a value in a JSON response matches what you expect.",
          "TCP: a port accepts connections.",
          "SSL certificate and domain expiry: warnings well before the date.",
          "Heartbeat: your job tells us it ran (see Heartbeats).",
        ],
      },
      {
        heading: "How an outage is confirmed",
        paragraphs: [
          "One failed check does not alert anyone. UptimeWatch repeats the check and asks other regions to check too. An incident opens only when the failure is confirmed, and it closes after the monitor has recovered for several checks in a row.",
          "If the problem might be on our side, such as a probe that cannot reach the internet, UptimeWatch does not page you.",
        ],
      },
      {
        heading: "What an alert tells you",
        list: [
          "What failed and where, with the timing of each step of the request.",
          "The likely cause in plain language and what to check first.",
          "What changed shortly before: deploys, certificate or address changes, and edits to the monitor.",
        ],
      },
    ],
  },
  {
    slug: "heartbeats",
    title: "Heartbeats",
    summary: "Know when a cron job, backup or worker stops running.",
    sections: [
      {
        heading: "How it works",
        paragraphs: [
          "Create a heartbeat, say how often the job should run and how much grace time it gets. UptimeWatch gives you a ping URL. If no ping arrives in time, or the job reports a failure, an incident opens.",
        ],
      },
      {
        heading: "Add it to your job",
        paragraphs: [
          "Call the ping URL at the end of the job. The URL is shown once when you create it; you can create a new one at any time.",
        ],
        code: 'curl -fsS "$WATCHPOST_PING_URL"',
      },
    ],
  },
  {
    slug: "alert-channels",
    title: "Alert channels",
    summary: "Send alerts to the tools your team already uses.",
    sections: [
      {
        heading: "Available channels",
        list: [
          "Email.",
          "Chat: Slack, Microsoft Teams, Discord, Telegram, Google Chat, Mattermost, Rocket.Chat, Zulip and Matrix.",
          "Push: Pushover, ntfy, Pushbullet and Gotify.",
          "On-call tools: PagerDuty, Opsgenie or Jira Service Management, and Splunk On-Call.",
          "Webhooks, signed, with custom headers. These also connect Zapier, Make and n8n.",
        ],
      },
      {
        heading: "Set up a channel",
        paragraphs: [
          "Open Integrations, pick the tool and follow the steps shown there. UptimeWatch sends a test message when the channel is saved. Each channel has its own rules: the lowest severity it accepts and which events it receives.",
          "Secrets such as tokens and webhook URLs are stored encrypted and are never shown again after you save them.",
        ],
      },
    ],
  },
  {
    slug: "deploy-markers",
    title: "Deploy markers",
    summary: "Tell UptimeWatch when you deploy, so incidents show what changed.",
    sections: [
      {
        heading: "Why",
        paragraphs: [
          "When an incident starts within 30 minutes of a deploy, the alert says so and suggests checking that deploy first. Deploys also appear on each monitor's recent changes.",
        ],
      },
      {
        heading: "From any CI",
        paragraphs: [
          "A workspace admin creates a deploy URL under Integrations, Deploy markers. Keep it in your CI's secret store and call it after each deploy. Only the version is required.",
        ],
        code: `curl -X POST "$WATCHPOST_DEPLOY_URL" \\
  -H 'content-type: application/json' \\
  -d '{"version":"'"$GIT_SHA"'","environment":"production","service":"api"}'`,
      },
      {
        heading: "From GitHub",
        paragraphs: [
          "Add a repository webhook with the GitHub URL and secret shown in UptimeWatch, content type application/json, and only the Deployment statuses event selected.",
        ],
      },
    ],
  },
];

export const findDocsPage = (slug: string) => DOCS_PAGES.find((page) => page.slug === slug);
