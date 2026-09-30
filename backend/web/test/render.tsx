/* Renders components with the same providers as the app (English messages, themes). */
import type * as React from "react";
import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider } from "next-themes";
import messages from "@/messages/en.json";

export function renderWithProviders(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
        {ui}
      </ThemeProvider>
    </NextIntlClientProvider>,
  );
}
