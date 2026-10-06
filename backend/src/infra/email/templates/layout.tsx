/*
 * Shared email layout (PRODUCT.md §10, React Email). Light colors are inline, so every client shows a
 * readable email; clients that support `prefers-color-scheme` (Apple Mail, Outlook for Mac, Gmail
 * apps) switch to the dark palette through the classes below, and Outlook.com's `[data-ogsc]` dark
 * mode gets the same overrides. Both palettes keep text contrast at WCAG AA (checked in tests).
 */
import type * as React from "react";
import { Body, Container, Head, Html, Preview, Section, Text } from "@react-email/components";

export const PALETTE = {
  light: {
    background: "#f5f5f5",
    card: "#ffffff",
    border: "#e5e5e5",
    text: "#171717",
    muted: "#525252",
    brand: "#4338ca",
    brandText: "#ffffff",
    down: "#b91c1c",
    up: "#15803d",
    warn: "#92400e",
  },
  dark: {
    background: "#141414",
    card: "#1f1f1f",
    border: "#333333",
    text: "#f2f2f2",
    muted: "#b5b5b5",
    brand: "#a5b4fc",
    brandText: "#141414",
    down: "#fca5a5",
    up: "#86efac",
    warn: "#fcd34d",
  },
} as const;

export type Tone = "down" | "up" | "warn" | "neutral";

const L = PALETTE.light;
const D = PALETTE.dark;

const darkCss = `
  .wp-body { background-color: ${D.background} !important; }
  .wp-card { background-color: ${D.card} !important; border-color: ${D.border} !important; }
  .wp-text { color: ${D.text} !important; }
  .wp-muted { color: ${D.muted} !important; }
  .wp-button { background-color: ${D.brand} !important; color: ${D.brandText} !important; }
  .wp-down { color: ${D.down} !important; }
  .wp-up { color: ${D.up} !important; }
  .wp-warn { color: ${D.warn} !important; }
`;

const CSS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) { ${darkCss} }
  ${darkCss
    .trim()
    .split("\n")
    .map((line) => `[data-ogsc] ${line.trim()}`)
    .join("\n")}
`;

export const styles = {
  body: {
    backgroundColor: L.background,
    margin: 0,
    padding: "24px 0",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  card: {
    backgroundColor: L.card,
    border: `1px solid ${L.border}`,
    borderRadius: "8px",
    padding: "28px",
    maxWidth: "560px",
  },
  heading: {
    color: L.text,
    fontSize: "20px",
    fontWeight: 600,
    lineHeight: "28px",
    margin: "0 0 12px",
  },
  text: { color: L.text, fontSize: "15px", lineHeight: "24px", margin: "0 0 12px" },
  muted: { color: L.muted, fontSize: "13px", lineHeight: "20px", margin: "0 0 8px" },
  button: {
    backgroundColor: L.brand,
    color: L.brandText,
    borderRadius: "6px",
    fontSize: "15px",
    fontWeight: 600,
    padding: "12px 20px",
    textDecoration: "none",
    display: "inline-block",
  },
  tone: {
    down: { color: L.down },
    up: { color: L.up },
    warn: { color: L.warn },
    neutral: { color: L.text },
  },
} satisfies Record<string, unknown>;

export function EmailLayout({
  preview,
  children,
  footer,
}: {
  preview: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Html lang="en">
      <Head>
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <style>{CSS}</style>
      </Head>
      <Preview>{preview}</Preview>
      <Body className="wp-body" style={styles.body}>
        <Container className="wp-card" style={styles.card}>
          <Text className="wp-muted" style={{ ...styles.muted, fontWeight: 600 }}>
            Watchpost
          </Text>
          {children}
          <Section>
            <Text className="wp-muted" style={{ ...styles.muted, marginTop: "20px" }}>
              {footer ?? "You get this email because of your Watchpost account."}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}
