/*
 * PDF documents (STACK.md: @react-pdf/renderer), behind one small adapter. Callers hand in a title
 * and blocks of content (headings, paragraphs, lists, tables); nothing outside this file knows the
 * library. Built-in fonts only, so rendering needs no files and no network.
 */
import type { ReactElement } from "react";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";

export type PdfBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "space" };

export interface PdfDocument {
  title: string;
  /* Small print at the foot of every page, before the page number. */
  footer?: string;
  blocks: PdfBlock[];
}

const styles = StyleSheet.create({
  page: {
    padding: 48,
    fontSize: 10.5,
    fontFamily: "Helvetica",
    color: "#171717",
    lineHeight: 1.45,
  },
  h1: { fontSize: 20, fontFamily: "Helvetica-Bold", marginBottom: 10 },
  h2: { fontSize: 14, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },
  h3: { fontSize: 11.5, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 4 },
  paragraph: { marginBottom: 6 },
  item: { flexDirection: "row", marginBottom: 3 },
  bullet: { width: 12 },
  itemText: { flex: 1 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#d4d4d4" },
  headerRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#525252" },
  cell: { flex: 1, paddingVertical: 4, paddingRight: 6 },
  headerCell: { flex: 1, paddingVertical: 4, paddingRight: 6, fontFamily: "Helvetica-Bold" },
  space: { height: 8 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    fontSize: 8.5,
    color: "#525252",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

/*
 * The built-in fonts cover Latin-1. Anything else would print as a wrong glyph, so common
 * typography is mapped to plain characters and the rest is replaced with "?".
 */
export function pdfSafe(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/•/g, "-")
    .replace(/→/g, "->")
    .replace(/[^\u0009\u000A -~ -ÿ]/g, "?");
}

function block(b: PdfBlock, index: number): ReactElement {
  switch (b.kind) {
    case "heading":
      return (
        <Text key={index} style={b.level === 1 ? styles.h1 : b.level === 2 ? styles.h2 : styles.h3}>
          {pdfSafe(b.text)}
        </Text>
      );
    case "paragraph":
      return (
        <Text key={index} style={styles.paragraph}>
          {pdfSafe(b.text)}
        </Text>
      );
    case "list":
      return (
        <View key={index} style={styles.paragraph}>
          {b.items.map((item, i) => (
            <View key={i} style={styles.item}>
              <Text style={styles.bullet}>-</Text>
              <Text style={styles.itemText}>{pdfSafe(item)}</Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <View key={index} style={styles.paragraph}>
          <View style={styles.headerRow}>
            {b.header.map((cell, i) => (
              <Text key={i} style={styles.headerCell}>
                {pdfSafe(cell)}
              </Text>
            ))}
          </View>
          {b.rows.map((row, r) => (
            <View key={r} style={styles.row} wrap={false}>
              {row.map((cell, i) => (
                <Text key={i} style={styles.cell}>
                  {pdfSafe(cell)}
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
    case "space":
      return <View key={index} style={styles.space} />;
  }
}

export async function renderPdf(doc: PdfDocument): Promise<Buffer> {
  return renderToBuffer(
    <Document title={pdfSafe(doc.title)} creator="Watchpost" producer="Watchpost">
      <Page size="A4" style={styles.page}>
        {doc.blocks.map(block)}
        <View style={styles.footer} fixed>
          <Text>{pdfSafe(doc.footer ?? "")}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>,
  );
}

/*
 * The small part of Markdown our own documents use (postmortems): #, ## and ### headings, "- "
 * lists and paragraphs. Emphasis marks are dropped; anything else is printed as it is written.
 */
export function markdownToBlocks(markdown: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const plain = (text: string) => text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: plain(paragraph.join(" ")) });
    if (list.length > 0) blocks.push({ kind: "list", items: list.map(plain) });
    paragraph = [];
    list = [];
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        level: (heading[1]?.length ?? 1) as 1 | 2 | 3,
        text: plain(heading[2] ?? ""),
      });
    } else if (item) {
      if (paragraph.length > 0) flush();
      list.push(item[1] ?? "");
    } else if (line.trim() === "") {
      flush();
    } else {
      if (list.length > 0) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks;
}
