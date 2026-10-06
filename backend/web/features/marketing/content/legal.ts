/*
 * Legal pages: DRAFTS that need owner review before launch (PRODUCT.md §2.5, Open decision #15).
 * Text in [square brackets] is a placeholder the owner must fill in. Not legal advice.
 */
import type { ContentPage } from "./types";

export const LEGAL_LAST_UPDATED = "2026-10-01";

export const LEGAL_PAGES: readonly ContentPage[] = [
  {
    slug: "terms",
    title: "Terms of Service",
    summary: "The agreement between you and Watchpost when you use the service.",
    sections: [
      {
        heading: "1. Who we are",
        paragraphs: [
          "Watchpost is operated by [legal entity name and address]. These terms apply to everyone who creates an account or uses the service on behalf of a workspace.",
        ],
      },
      {
        heading: "2. Your account",
        list: [
          "You must give a working email address and keep your sign-in details secret.",
          "You are responsible for what happens in your workspace, including what the people you invite do.",
          "You must be allowed to monitor the sites, servers and services you add.",
        ],
      },
      {
        heading: "3. Plans and payment",
        paragraphs: [
          "The Free plan costs nothing and may be used commercially. Paid plans are billed in advance, monthly or yearly, through Paddle, which is the merchant of record and handles payment, tax and invoices. Prices are shown on the pricing page.",
          "You can cancel at any time. A canceled plan stays active until the end of the period already paid for, and the workspace then moves to the Free plan. Moving to a smaller plan never deletes data: monitors over the new limit are paused. Refunds are described in the Refund Policy.",
        ],
      },
      {
        heading: "4. Acceptable use",
        paragraphs: [
          "You must follow the Acceptable Use Policy. We may pause monitors or suspend a workspace that breaks it.",
        ],
      },
      {
        heading: "5. The service",
        paragraphs: [
          "We work to keep Watchpost available and accurate, but monitoring depends on networks and third parties that we do not control. Alerts may be late, missing or wrong. Watchpost is not a replacement for your own safety measures where an outage could cause injury or serious loss.",
        ],
      },
      {
        heading: "6. Your data",
        paragraphs: [
          "You keep ownership of the data you put into Watchpost. We use it only to provide the service, as described in the Privacy Policy.",
        ],
      },
      {
        heading: "7. Liability",
        paragraphs: [
          "To the extent the law allows, the service is provided as it is, and our total liability for any claim is limited to the amount you paid us in the 12 months before the claim. [Owner: confirm this clause with a lawyer for your jurisdiction.]",
        ],
      },
      {
        heading: "8. Changes and ending",
        paragraphs: [
          "We may change these terms and will tell workspace owners by email at least 30 days before a change that affects them. You may stop using the service at any time. We may end an account that breaks these terms.",
        ],
      },
      {
        heading: "9. Law and contact",
        paragraphs: [
          "These terms are governed by the law of [jurisdiction]. Questions: [contact email].",
        ],
      },
    ],
  },
  {
    slug: "privacy",
    title: "Privacy Policy",
    summary: "What personal data Watchpost handles, why, and who else receives it.",
    sections: [
      {
        heading: "1. Who is responsible",
        paragraphs: [
          "[Legal entity name and address] is responsible for the personal data described here. Contact: [privacy contact email].",
        ],
      },
      {
        heading: "2. What we collect",
        list: [
          "Account data: your name, email address and a hashed password.",
          "Workspace data: the monitors, alert channels, incidents and settings your team creates.",
          "Check results: response times, status codes and short excerpts of responses from the addresses you ask us to check.",
          "Technical data: IP address, browser type and the time of requests, kept in server logs for security.",
          "Billing data: handled by Paddle. We receive your plan, payment status and country, not your card number.",
        ],
      },
      {
        heading: "3. Why we use it",
        list: [
          "To run the monitoring you asked for and send you alerts.",
          "To keep accounts secure and prevent abuse.",
          "To bill paid plans and meet legal duties such as tax records.",
          "To email you about your account and incidents. We do not sell personal data and the app has no third-party advertising trackers.",
        ],
      },
      {
        heading: "4. Who else receives data",
        paragraphs: [
          "We use these providers to run the service. Each receives only what it needs.",
        ],
        list: [
          "Paddle: payments, tax and invoices (merchant of record).",
          "Resend: delivery of email.",
          "Cloudflare R2: storage of files and backups.",
          "Anthropic: text of an incident when AI summaries are used.",
          "Twilio: phone numbers and message text for SMS and voice alerts, once those are enabled.",
          "The alert channels you connect (for example Slack or PagerDuty) receive the alerts you send to them.",
          "[Hosting provider and server location, to be added when the production servers are chosen.]",
        ],
      },
      {
        heading: "5. How long we keep it",
        paragraphs: [
          "Check results are kept for the history period of your plan. Account and workspace data are kept while the account exists. Server logs are kept for [period]. Billing records are kept as long as tax law requires.",
        ],
      },
      {
        heading: "6. Your rights",
        paragraphs: [
          "You can ask for a copy of your data, a correction, or deletion of your account and workspace by writing to [privacy contact email]. If you are in the EU or UK you also have the right to object, to restrict processing and to complain to your data protection authority. [Owner: confirm legal bases and transfer safeguards with a lawyer.]",
        ],
      },
      {
        heading: "7. Security",
        paragraphs: [
          "Tokens and secrets for your alert channels are encrypted at rest. Passwords are hashed. Access to production systems is limited to the people who operate the service.",
        ],
      },
    ],
  },
  {
    slug: "acceptable-use",
    title: "Acceptable Use Policy",
    summary: "What Watchpost may and may not be used for.",
    sections: [
      {
        heading: "You may",
        list: [
          "Monitor sites, APIs, servers and jobs that you own or have permission to monitor.",
          "Use the Free plan for commercial projects.",
        ],
      },
      {
        heading: "You may not",
        list: [
          "Use checks for load testing, stress testing or denial-of-service attacks.",
          "Monitor systems you have no permission to check, or scan networks for open ports or weaknesses.",
          "Point monitors at internal or private network addresses through our public probes.",
          "Send spam, harassment or unlawful content through alert channels.",
          "Create many accounts to get around plan limits.",
          "Try to break, overload or gain unauthorized access to Watchpost or other customers' data.",
        ],
      },
      {
        heading: "Enforcement",
        paragraphs: [
          "If a workspace breaks this policy we may pause its monitors or suspend it, and we will tell the workspace owner why. To report abuse, including checks from Watchpost that you did not ask for, write to [abuse contact email].",
        ],
      },
    ],
  },
  {
    slug: "refunds",
    title: "Refund Policy",
    summary: "When you can get your money back.",
    sections: [
      {
        heading: "Subscriptions",
        paragraphs: [
          "If you are not satisfied, ask for a refund within [14] days of your first payment for a paid plan and we will refund it in full. Renewals are not refunded after they are charged, but you can cancel at any time and keep the plan until the end of the period you paid for. [Owner: confirm the refund window.]",
        ],
      },
      {
        heading: "Alert credits",
        paragraphs: [
          "Credits that were used by an incident you mark as a false alarm are returned to your balance automatically. Purchased credit packs do not expire. Unused purchased credits can be refunded within [14] days of purchase.",
        ],
      },
      {
        heading: "How to ask",
        paragraphs: [
          "Write to [support contact email] from the email address of a workspace owner. Refunds are paid through Paddle to the original payment method.",
        ],
      },
    ],
  },
];

export const findLegalPage = (slug: string) => LEGAL_PAGES.find((page) => page.slug === slug);
