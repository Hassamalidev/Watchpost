import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

/*
 * In production Caddy serves /api/* from the API on the same host. In development and e2e tests the
 * web server proxies /api/* to API_URL, so the browser always talks to one origin (cookies, CSRF).
 */
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default withNextIntl(nextConfig);
