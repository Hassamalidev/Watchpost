/* Badge images and the words on them. */
import { describe, expect, it } from "vitest";
import { formatLatency, formatUptime, uptimeColor } from "../badges.service.js";
import { BADGE_COLORS, renderBadge, textWidth } from "../render.js";

describe("renderBadge", () => {
  it("draws a label and a message, sized to the text, with a readable name", () => {
    const svg = renderBadge({ label: "status", message: "up", color: "green" });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('role="img" aria-label="status: up"');
    expect(svg).toContain("<title>status: up</title>");
    expect(svg).toContain(`fill="${BADGE_COLORS.green}"`);
    const width = Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width).toBe(textWidth("status") + textWidth("up") + 24);
    /* A longer message makes a wider image. */
    const wide = renderBadge({ label: "status", message: "maintenance", color: "blue" });
    expect(Number(/width="(\d+)"/.exec(wide)?.[1])).toBeGreaterThan(width);
  });

  it("escapes text, so a label can never add markup", () => {
    const svg = renderBadge({ label: '<script>"&', message: "</svg>'", color: "gray" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;");
    expect(svg).toContain("&lt;/svg&gt;&apos;");
    expect(svg.match(/<svg/g)).toHaveLength(1);
  });
});

describe("the words on a badge", () => {
  it("writes uptime without needless digits", () => {
    expect(formatUptime(100)).toBe("100%");
    expect(formatUptime(99.987)).toBe("99.987%");
    expect(formatUptime(99.95)).toBe("99.95%");
    expect(formatUptime(99.9)).toBe("99.9%");
    expect(formatUptime(98.4321)).toBe("98.43%");
    expect(formatUptime(97)).toBe("97%");
  });

  it("colors uptime by the same thresholds as the status page bars", () => {
    expect(uptimeColor(100)).toBe("green");
    expect(uptimeColor(99.9)).toBe("green");
    expect(uptimeColor(99.5)).toBe("amber");
    expect(uptimeColor(98.9)).toBe("red");
  });

  it("writes response times in the unit a person would use", () => {
    expect(formatLatency(84.4)).toBe("84 ms");
    expect(formatLatency(999.4)).toBe("999 ms");
    expect(formatLatency(1_240)).toBe("1.2 s");
    expect(formatLatency(12_400)).toBe("12 s");
  });
});
