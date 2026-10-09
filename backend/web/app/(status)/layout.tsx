/*
 * Root layout of public status pages (PRODUCT.md §14). It is separate from the app's layout so a
 * visitor downloads no app code: no theme switcher, no data client, no translations bundle. The
 * page follows the visitor's system theme through one tiny inline script, so the first paint is
 * already in the right colors.
 */
import type { Metadata, Viewport } from "next";
import type * as React from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "../globals.css";

export const metadata: Metadata = { title: "Status" };

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#141414" },
  ],
};

const FOLLOW_SYSTEM_THEME =
  "try{if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.classList.add('dark')}catch(e){}";

/*
 * Nothing here asks for translations: the page below picks the visitor's language first (page
 * languages, PRODUCT.md §6.6) and names it on its own element. Asking here would settle on English
 * before the page had its say.
 */
export default function StatusLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: FOLLOW_SYSTEM_THEME }} />
      </head>
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
