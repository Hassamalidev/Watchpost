/* Typed translation keys: a missing or misspelled message key fails the typecheck. */
import type messages from "./messages/en.json";

declare module "next-intl" {
  interface AppConfig {
    Messages: typeof messages;
  }
}
