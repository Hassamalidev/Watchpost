/*
 * Host-based routing for status pages (PRODUCT.md §14): a request to <slug>.<STATUS_BASE_DOMAIN>,
 * or to a customer's own domain, is served the page at /s/<slug or host>. Everything else passes
 * through untouched.
 */
import { NextResponse, type NextRequest } from "next/server";
import { realHost, statusPathFor, statusRefForHost } from "@/lib/status-host";

const ownHosts = (process.env.PRIMARY_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter((host) => host !== "");

export function proxy(request: NextRequest) {
  const ref = statusRefForHost(request.headers.get("host"), {
    baseDomain: realHost(process.env.STATUS_BASE_DOMAIN),
    appDomain: realHost(process.env.APP_DOMAIN),
    ownHosts,
  });
  if (ref === undefined) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = statusPathFor(ref, url.pathname);
  return NextResponse.rewrite(url);
}

/* API calls, Next's own files and static assets are the same on every host. */
export const config = {
  matcher: ["/((?!api/|_next/|icons/|favicon.ico|sw.js|manifest.webmanifest).*)"],
};
