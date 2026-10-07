/* The install manifest: lets phones and desktops add UptimeWatch to the home screen as an app. */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "UptimeWatch",
    short_name: "UptimeWatch",
    description: "Uptime monitoring, on-call and status pages. Acknowledge alerts from your phone.",
    /* The workspace picker sends you on to your workspace. */
    start_url: "/w",
    scope: "/",
    display: "standalone",
    background_color: "#141414",
    theme_color: "#141414",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
