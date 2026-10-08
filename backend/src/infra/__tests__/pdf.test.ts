/* PDF rendering: the markdown subset, safe characters, and that a real PDF comes out. */
import { describe, expect, it } from "vitest";
import { markdownToBlocks, pdfSafe, renderPdf } from "../pdf.js";

describe("markdownToBlocks", () => {
  it("reads headings, lists and paragraphs, and drops emphasis marks", () => {
    expect(
      markdownToBlocks(
        "# Title\n\nFirst **bold** line\ncontinues here.\n\n## What happened\n- one `code`\n- two\n\nLast.",
      ),
    ).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "First bold line continues here." },
      { kind: "heading", level: 2, text: "What happened" },
      { kind: "list", items: ["one code", "two"] },
      { kind: "paragraph", text: "Last." },
    ]);
    expect(markdownToBlocks("")).toEqual([]);
  });
});

describe("renderPdf", () => {
  it("maps typography the built-in fonts lack to plain characters", () => {
    expect(pdfSafe("It’s “down” — 5 min → up… é")).toBe('It\'s "down" - 5?min -> up... é');
  });

  it("renders a PDF with every kind of block", async () => {
    const pdf = await renderPdf({
      title: "Postmortem: checkout outage",
      footer: "Acme",
      blocks: [
        { kind: "heading", level: 1, text: "Postmortem" },
        { kind: "paragraph", text: "What happened, in a sentence." },
        { kind: "list", items: ["first", "second"] },
        { kind: "space" },
        { kind: "table", header: ["Monitor", "Uptime"], rows: [["API", "99.95%"]] },
      ],
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1_000);
    expect(pdf.toString("latin1")).toContain("/Title");
  }, 30_000);
});
