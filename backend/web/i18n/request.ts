/*
 * next-intl request config. The app is in English; locales are added by demand (PRODUCT.md §14).
 * Public status pages are the exception (§6.6): their fixed text comes in the languages of
 * `STATUS_PAGE_LANGUAGES`, and the page sets the language it renders in.
 */
import { getRequestConfig } from "next-intl/server";
import { isStatusPageLanguage } from "@app/shared";
import english from "../messages/en.json";

export const DEFAULT_LOCALE = "en";

export default getRequestConfig(async ({ locale: asked, requestLocale }) => {
  const wanted = asked ?? (await requestLocale);
  const locale = isStatusPageLanguage(wanted) ? wanted : DEFAULT_LOCALE;
  if (locale === DEFAULT_LOCALE) return { locale, messages: english };
  const statusPage = (await import(`../features/statuspages/locales/${locale}.json`)) as {
    default: (typeof english)["statusPage"];
  };
  return { locale, messages: { ...english, statusPage: statusPage.default } };
});
