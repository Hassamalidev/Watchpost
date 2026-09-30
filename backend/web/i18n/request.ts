/* next-intl request config. English only for now; locales are added by demand (PRODUCT.md §14). */
import { getRequestConfig } from "next-intl/server";

export const DEFAULT_LOCALE = "en";

export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;
  const messages = (await import(`../messages/${locale}.json`)) as {
    default: Record<string, unknown>;
  };
  return { locale, messages: messages.default };
});
