/* sitemap.xml: every public page that should be found. Legal drafts stay out until reviewed. */
import type { MetadataRoute } from "next";
import { COMPETITORS } from "@/features/marketing/competitors";
import { DOCS_PAGES } from "@/features/marketing/content/docs";
import { absoluteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const entry = (
    path: string,
    priority: number,
    changeFrequency: "weekly" | "monthly",
  ): MetadataRoute.Sitemap[number] => ({ url: absoluteUrl(path), changeFrequency, priority });

  return [
    entry("/", 1, "weekly"),
    entry("/pricing", 0.9, "monthly"),
    entry("/alternatives/opsgenie", 0.8, "monthly"),
    ...COMPETITORS.map((competitor) => entry(`/compare/${competitor.slug}`, 0.7, "monthly")),
    entry("/docs", 0.6, "monthly"),
    ...DOCS_PAGES.map((page) => entry(`/docs/${page.slug}`, 0.5, "monthly")),
    entry("/signup", 0.5, "monthly"),
    entry("/login", 0.3, "monthly"),
  ];
}
