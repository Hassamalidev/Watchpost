/* Public site: every page shares the header and the footer. */
import type * as React from "react";
import { SiteFooter, SiteHeader } from "@/features/marketing/components/site-chrome";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
