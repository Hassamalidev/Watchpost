/*
 * What search engines and link previews are told about the public site: its name, its address and
 * the structured data of the landing page. The address comes from WEB_ORIGIN, so previews, the
 * sitemap and canonical links name the real host once it is set.
 */
export const SITE_NAME = "UptimeWatch";

export const SITE_TAGLINE = "Uptime monitoring that confirms outages before it alerts";

export const SITE_DESCRIPTION =
  "Website uptime monitoring with multi-region confirmation, on-call schedules and status pages. Monitor HTTP, ping, ports, DNS, SSL and cron jobs. 20 monitors free, no card.";

export const SITE_KEYWORDS = [
  "uptime monitoring",
  "website monitoring",
  "website uptime monitor",
  "free uptime monitoring",
  "server monitoring",
  "API monitoring",
  "ping monitoring",
  "port monitoring",
  "DNS monitoring",
  "SSL certificate monitoring",
  "domain expiry monitoring",
  "cron job monitoring",
  "heartbeat monitoring",
  "status page",
  "on-call scheduling",
  "downtime alerts",
  "UptimeRobot alternative",
  "Uptime Kuma alternative",
  "Better Stack alternative",
  "Opsgenie alternative",
];

export function siteUrl(origin: string | undefined = process.env.WEB_ORIGIN): string {
  const value = origin?.trim().replace(/\/+$/, "");
  return value ? value : "http://localhost:3000";
}

export const absoluteUrl = (path: string, origin?: string) =>
  `${siteUrl(origin)}${path === "/" ? "" : path}`;

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface LandingOffer {
  name: string;
  /* US dollars per month. */
  price: number;
}

/*
 * schema.org data for the landing page: who we are, the site, the product with its plans, and the
 * questions shown on the page. No ratings or review counts: there are none to report yet.
 */
export function landingJsonLd(input: {
  faq: readonly FaqEntry[];
  offers: readonly LandingOffer[];
  features: readonly string[];
  origin?: string;
}) {
  const home = absoluteUrl("/", input.origin);
  const prices = input.offers.map((offer) => offer.price);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${home}/#organization`,
        name: SITE_NAME,
        url: home,
        logo: absoluteUrl("/icons/icon-512.png", input.origin),
      },
      {
        "@type": "WebSite",
        "@id": `${home}/#website`,
        name: SITE_NAME,
        url: home,
        description: SITE_DESCRIPTION,
        inLanguage: "en",
        publisher: { "@id": `${home}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        "@id": `${home}/#software`,
        name: SITE_NAME,
        url: home,
        description: SITE_DESCRIPTION,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Uptime monitoring",
        operatingSystem: "Web",
        featureList: input.features,
        publisher: { "@id": `${home}/#organization` },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "USD",
          lowPrice: Math.min(...prices),
          highPrice: Math.max(...prices),
          offerCount: input.offers.length,
          offers: input.offers.map((offer) => ({
            "@type": "Offer",
            name: offer.name,
            price: offer.price,
            priceCurrency: "USD",
            url: absoluteUrl("/pricing", input.origin),
          })),
        },
      },
      {
        "@type": "FAQPage",
        "@id": `${home}/#faq`,
        mainEntity: input.faq.map((entry) => ({
          "@type": "Question",
          name: entry.question,
          acceptedAnswer: { "@type": "Answer", text: entry.answer },
        })),
      },
    ],
  };
}

/* Serialized for a script tag: "<" is escaped so no text can close the tag. */
export const serializeJsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
