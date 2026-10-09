/*
 * Status page languages: every dictionary says the same things as the English one, the visitor's
 * language is picked from what the page has, and the page renders in it with a way to switch.
 */
import { render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import {
  STATUS_PAGE_LANGUAGES,
  STATUS_PAGE_LANGUAGE_NAMES,
  pickStatusPageLanguage,
  statusPageSettingsSchema,
  type PublicStatusPage,
} from "@app/shared";
import english from "@/messages/en.json";
import de from "@/features/statuspages/locales/de.json";
import es from "@/features/statuspages/locales/es.json";
import fr from "@/features/statuspages/locales/fr.json";
import it_ from "@/features/statuspages/locales/it.json";
import nl from "@/features/statuspages/locales/nl.json";
import pt from "@/features/statuspages/locales/pt.json";
import { StatusPageView, formatUtc } from "@/features/statuspages/components/status-page-view";

type Tree = { [key: string]: string | Tree };
const dictionaries: Record<string, Tree> = { de, es, fr, it: it_, nl, pt };

/* Every message by its path, with the placeholders it has. */
function flatten(tree: Tree, prefix = ""): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === "string") {
      out[prefix + key] = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    } else Object.assign(out, flatten(value, `${prefix}${key}.`));
  }
  return out;
}

const data = (languages: PublicStatusPage["page"]["languages"]): PublicStatusPage => ({
  page: {
    name: "Acme",
    slug: "acme",
    url: "https://acme.status.example.net",
    branding: {
      logoUrl: null,
      faviconUrl: null,
      accentColor: null,
      description: null,
      supportUrl: null,
    },
    languages,
    subscribe: true,
    showUptime: true,
    poweredByUrl: "https://watchpost.example.net",
  },
  status: "operational",
  components: [
    { id: "c1", name: "API", description: null, group: null, status: "operational", uptime: null },
  ],
  incidents: { active: [], recent: [] },
  maintenance: [],
  generatedAt: "2026-10-09T14:05:00.000Z",
});

describe("status page dictionaries", () => {
  it("has one for every language but English, each named in its own language", () => {
    expect(Object.keys(dictionaries).sort()).toEqual(
      STATUS_PAGE_LANGUAGES.filter((language) => language !== "en").sort(),
    );
    expect(STATUS_PAGE_LANGUAGE_NAMES.de).toBe("Deutsch");
  });

  it.each(Object.entries(dictionaries))(
    "%s says everything the English one says, with the same placeholders",
    (_language, dictionary) => {
      expect(flatten(dictionary)).toEqual(flatten(english.statusPage));
      for (const text of Object.keys(flatten(dictionary))) expect(text).not.toBe("");
    },
  );
});

describe("picking the visitor's language", () => {
  it("takes what was asked for when the page has it", () => {
    expect(pickStatusPageLanguage(["en", "de", "fr"], "fr", "de-DE,de;q=0.9")).toBe("fr");
    expect(pickStatusPageLanguage(["en", "de"], "fr", null)).toBe("en");
  });

  it("follows the browser's languages in their order of preference", () => {
    expect(pickStatusPageLanguage(["en", "de", "fr"], undefined, "de-CH,de;q=0.9,en;q=0.8")).toBe(
      "de",
    );
    expect(pickStatusPageLanguage(["en", "fr"], undefined, "de;q=0.9,fr;q=0.95,en;q=0.5")).toBe(
      "fr",
    );
    expect(pickStatusPageLanguage(["nl", "en"], undefined, "ja,zh;q=0.8")).toBe("nl");
    expect(pickStatusPageLanguage(["nl", "en"], undefined, "en;q=0, nl;q=0")).toBe("nl");
    expect(pickStatusPageLanguage([], undefined, undefined)).toBe("en");
  });

  it("gives older pages English, and takes each language once", () => {
    expect(statusPageSettingsSchema.parse({}).languages).toEqual(["en"]);
    expect(statusPageSettingsSchema.safeParse({ languages: ["de", "de"] }).success).toBe(false);
    expect(statusPageSettingsSchema.safeParse({ languages: [] }).success).toBe(false);
    expect(statusPageSettingsSchema.safeParse({ languages: ["xx"] }).success).toBe(false);
  });
});

describe("a page in another language", () => {
  const show = (languages: PublicStatusPage["page"]["languages"], locale: string) =>
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "de" ? { ...english, statusPage: de } : english}
      >
        <StatusPageView
          data={data(languages)}
          feedBase="/api/public/status/acme"
          subscribeAction="/api/public/status/acme/subscribers"
        />
      </NextIntlClientProvider>,
    );

  it("says its fixed text in German, with dates the German way", () => {
    show(["de", "en"], "de");
    expect(screen.getByText("Alle Systeme in Betrieb")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dienste" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Abonnieren" })).toBeInTheDocument();
    expect(
      screen.getByText(`Aktualisiert ${formatUtc("2026-10-09T14:05:00.000Z", "de")}`),
    ).toBeInTheDocument();
    expect(formatUtc("2026-10-09T14:05:00.000Z", "de")).toMatch(/^9\. Okt\.? 2026.*14:05 UTC$/);
    expect(formatUtc("2026-10-09T14:05:00.000Z")).toBe("9 Oct 2026, 14:05 UTC");
  });

  it("offers the page's other languages, and marks the current one", () => {
    show(["de", "en"], "de");
    const switcher = screen.getByRole("navigation", { name: "Sprache" });
    const links = within(switcher).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Deutsch", "English"]);
    expect(links[0]).toHaveAttribute("aria-current", "true");
    expect(links[1]).toHaveAttribute("href", "?lang=en");
    expect(links[1]).toHaveAttribute("lang", "en");
    expect(links[1]).not.toHaveAttribute("aria-current");
  });

  it("has no switcher when the page has one language", () => {
    show(["en"], "en");
    expect(screen.queryByRole("navigation", { name: "Language" })).not.toBeInTheDocument();
    expect(screen.getByText("All systems operational")).toBeInTheDocument();
  });
});
