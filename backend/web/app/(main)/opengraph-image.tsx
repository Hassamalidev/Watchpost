/* The picture shown when a link to the site is shared: the name, the promise and a row of uptime bars. */
import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/site";

export const alt = "UptimeWatch: uptime monitoring that confirms an outage before it alerts";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BARS = Array.from({ length: 40 }, (_, index) => index);

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: 72,
        color: "#f5f5f5",
        backgroundColor: "#141414",
        backgroundImage:
          "radial-gradient(circle at 85% 0%, rgba(140, 130, 255, 0.35), #141414 55%)",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, fontWeight: 600 }}
      >
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: "#a5a0ff",
            display: "flex",
          }}
        />
        {SITE_NAME}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", fontSize: 76, fontWeight: 700, lineHeight: 1.08 }}>
          Uptime monitoring that confirms an outage before it wakes you up.
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#b8b8b8" }}>
          Multi-region checks · On-call · Status pages · 20 monitors free
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {BARS.map((bar) => (
          <div
            key={bar}
            style={{
              flex: 1,
              height: 44,
              borderRadius: 6,
              backgroundColor: bar === 27 ? "#f0b34a" : "#56c98a",
              display: "flex",
            }}
          />
        ))}
      </div>
    </div>,
    size,
  );
}
