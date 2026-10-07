/*
 * RSS 2.0 and Atom feeds of a status page's incident updates (PRODUCT.md §6.6). One entry per
 * update, newest first. Pure: the caller hands in what the public page already shows.
 */
import type { PublicStatusIncident, PublicStatusPage } from "@app/shared";

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const STATUS_LABEL = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
} as const;

export const FEED_MAX_ENTRIES = 50;

interface Entry {
  id: string;
  title: string;
  body: string;
  at: string;
  link: string;
}

function entriesOf(page: PublicStatusPage): Entry[] {
  const incidents: PublicStatusIncident[] = [...page.incidents.active, ...page.incidents.recent];
  return incidents
    .flatMap((incident) =>
      incident.updates.map((update) => ({
        id: update.id,
        title: `${STATUS_LABEL[update.status]}: ${incident.title}`,
        body: update.message,
        at: update.at,
        link: `${page.page.url}#incident-${incident.id}`,
      })),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, FEED_MAX_ENTRIES);
}

export function renderRss(page: PublicStatusPage): string {
  const entries = entriesOf(page);
  const items = entries
    .map(
      (e) => `    <item>
      <title>${escapeXml(e.title)}</title>
      <link>${escapeXml(e.link)}</link>
      <guid isPermaLink="false">${escapeXml(e.id)}</guid>
      <pubDate>${new Date(e.at).toUTCString()}</pubDate>
      <description>${escapeXml(e.body)}</description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(`${page.page.name} status`)}</title>
    <link>${escapeXml(page.page.url)}</link>
    <description>${escapeXml(`Incidents and updates for ${page.page.name}`)}</description>
    <lastBuildDate>${new Date(entries[0]?.at ?? page.generatedAt).toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

export function renderAtom(page: PublicStatusPage, selfUrl: string): string {
  const entries = entriesOf(page);
  const items = entries
    .map(
      (e) => `  <entry>
    <id>urn:uuid:${escapeXml(e.id)}</id>
    <title>${escapeXml(e.title)}</title>
    <link href="${escapeXml(e.link)}"/>
    <updated>${escapeXml(e.at)}</updated>
    <content type="text">${escapeXml(e.body)}</content>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(page.page.url)}</id>
  <title>${escapeXml(`${page.page.name} status`)}</title>
  <link href="${escapeXml(page.page.url)}"/>
  <link rel="self" href="${escapeXml(selfUrl)}"/>
  <updated>${escapeXml(entries[0]?.at ?? page.generatedAt)}</updated>
  <author><name>${escapeXml(page.page.name)}</name></author>
${items}
</feed>
`;
}
