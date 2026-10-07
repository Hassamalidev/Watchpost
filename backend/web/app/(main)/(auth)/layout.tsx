/* Auth pages: one centered column with the product name. */
import type * as React from "react";
import Link from "next/link";
import { Radar } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-4">
      <Link href="/" className="flex items-center gap-2 font-semibold">
        <Radar aria-hidden className="size-5 text-brand" />
        Watchpost
      </Link>
      <main className="w-full max-w-sm">{children}</main>
    </div>
  );
}
