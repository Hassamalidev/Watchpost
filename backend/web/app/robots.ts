/*
 * robots.txt: the public site is open to crawlers; the app, the API and one-time links are not.
 * Legal drafts are not listed here: they carry `noindex`, which a crawler has to be able to read.
 */
import type { MetadataRoute } from "next";
import { absoluteUrl, siteUrl } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/w/", "/a/", "/onboarding", "/invite/", "/verify"],
    },
    sitemap: absoluteUrl("/sitemap.xml"),
    host: siteUrl(),
  };
}
