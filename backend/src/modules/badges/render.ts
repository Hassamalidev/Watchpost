/*
 * SVG badges in the familiar flat two-part shape: a gray label and a colored message. Pure: text in,
 * SVG out. Widths come from a small table of character widths (Verdana 11 px, the font the badge asks
 * for), so the same text always gives the same image and no font has to be measured.
 */

export const BADGE_COLORS = {
  green: "#2ea44f",
  amber: "#b58105",
  red: "#cf222e",
  blue: "#0969da",
  gray: "#6e7781",
} as const;
export type BadgeColor = keyof typeof BADGE_COLORS;

export interface Badge {
  label: string;
  message: string;
  color: BadgeColor;
}

const NARROW = new Set([..."iIl.,:;|!'j1 "]);
const WIDE = new Set([..."mwMW%@"]);

/* Close enough to the rendered width that text never touches the edge. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (NARROW.has(char)) width += 4;
    else if (WIDE.has(char)) width += 10.5;
    else if (char >= "A" && char <= "Z") width += 7.8;
    else width += 6.6;
  }
  return Math.round(width);
}

const escapeXml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const PADDING = 6;

export function renderBadge(badge: Badge): string {
  const label = escapeXml(badge.label);
  const message = escapeXml(badge.message);
  const labelWidth = textWidth(badge.label) + PADDING * 2;
  const messageWidth = textWidth(badge.message) + PADDING * 2;
  const width = labelWidth + messageWidth;
  const title = `${label}: ${message}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${title}">` +
    `<title>${title}</title>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>` +
    `<g clip-path="url(#r)">` +
    `<rect width="${labelWidth}" height="20" fill="#555"/>` +
    `<rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${BADGE_COLORS[badge.color]}"/>` +
    `</g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${labelWidth / 2}" y="14">${label}</text>` +
    `<text x="${labelWidth + messageWidth / 2}" y="14">${message}</text>` +
    `</g></svg>`
  );
}
