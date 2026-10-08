/*
 * Failure explainer (PRODUCT.md §4 pillar 2, "alerts that explain themselves"): turns the evidence of
 * a failed check into a plain-language cause and the first things to check — deterministic, instant
 * and free, so every alert carries it (the AI explanation in Phase 5 adds to it, never replaces it).
 * Pure: the API puts it in alerts, the web app shows it on incidents and monitors.
 */
import type { CheckErrorCode } from "../constants/check-errors.js";

export type FailureCategory =
  "dns" | "network" | "tls" | "http" | "content" | "timeout" | "heartbeat" | "config" | "unknown";

export interface FailureFacts {
  errorCode: CheckErrorCode | string | null;
  httpStatus?: number | null | undefined;
  /* Regions where the check failed, and how many regions check the monitor. */
  failingRegions?: readonly string[] | undefined;
  totalRegions?: number | undefined;
  /* Hostname or URL, for sentences like "api.example.com doesn't resolve". */
  target?: string | null | undefined;
  /* Phase timings of the failing check, in ms. */
  timings?: { dns?: number; connect?: number; tls?: number; ttfb?: number } | null | undefined;
}

export interface Explanation {
  category: FailureCategory;
  /* One short sentence for alert titles and banners. */
  headline: string;
  /* What it most likely means. */
  detail: string;
  /* First things to check, most likely first. */
  nextSteps: string[];
  /* Whether every checking region saw it (likely the service) or only some (likely a network path). */
  scope: "everywhere" | "some-regions" | "unknown";
}

function hostOf(target: string | null | undefined): string {
  if (!target) return "the target";
  try {
    return new URL(target).hostname;
  } catch {
    return target;
  }
}

function httpExplanation(
  status: number | null | undefined,
  host: string,
): Omit<Explanation, "scope"> {
  if (status === null || status === undefined) {
    return {
      category: "http",
      headline: "Unexpected HTTP response",
      detail: `${host} answered, but not with an accepted status code.`,
      nextSteps: [
        "Open the URL yourself and compare with the accepted status codes in the monitor.",
      ],
    };
  }
  const base = { category: "http" as const };
  if (status === 502 || status === 504) {
    return {
      ...base,
      headline: `Gateway error (HTTP ${status}): the app behind the proxy isn't answering`,
      detail: `A proxy or load balancer in front of ${host} is up, but the application behind it ${status === 504 ? "timed out" : "returned an invalid response or is down"}.`,
      nextSteps: [
        "Check that the application servers or containers behind the load balancer are running.",
        "Look at the app's logs for crashes or out-of-memory restarts around the start time.",
        "Check upstream timeouts if the app is just slow.",
      ],
    };
  }
  if (status === 503) {
    return {
      ...base,
      headline: "Service unavailable (HTTP 503): overloaded or in maintenance",
      detail: `${host} says it can't serve requests right now — usually overload, a maintenance mode, or no healthy backends.`,
      nextSteps: [
        "Check whether a deploy or maintenance mode is in progress.",
        "Check backend health checks and capacity (CPU, connections, queue depth).",
      ],
    };
  }
  if (status >= 500) {
    return {
      ...base,
      headline: `Server error (HTTP ${status})`,
      detail: `${host} is reachable but the application fails while handling the request.`,
      nextSteps: [
        "Check the application's error logs or error tracker for the start time.",
        "Roll back the latest deploy if the errors began right after it.",
      ],
    };
  }
  if (status === 401 || status === 403) {
    return {
      ...base,
      headline: `Access denied (HTTP ${status})`,
      detail: `${host} refuses our probes — a firewall, WAF or bot protection may be blocking them, or credentials changed.`,
      nextSteps: [
        "Check WAF / bot-protection rules and allow the Watchpost probe IPs.",
        "If the monitor sends credentials, check they're still valid.",
      ],
    };
  }
  if (status === 404 || status === 410) {
    return {
      ...base,
      headline: `Page not found (HTTP ${status})`,
      detail: `The URL no longer exists on ${host} — it may have moved, or a deploy removed the route.`,
      nextSteps: [
        "Check whether the path changed in the latest release.",
        "Update the monitor's URL if it moved.",
      ],
    };
  }
  if (status === 429) {
    return {
      ...base,
      headline: "Rate limited (HTTP 429)",
      detail: `${host} is throttling our checks.`,
      nextSteps: [
        "Allow the Watchpost probe IPs in your rate limiter, or lower the check frequency.",
      ],
    };
  }
  return {
    ...base,
    headline: `Unexpected status (HTTP ${status})`,
    detail: `${host} answered with HTTP ${status}, which the monitor doesn't accept.`,
    nextSteps: [
      "Open the URL yourself, or adjust the accepted status codes if this response is expected.",
    ],
  };
}

function explainCode(facts: FailureFacts): Omit<Explanation, "scope"> {
  const host = hostOf(facts.target);
  switch (facts.errorCode) {
    case "dns_nxdomain":
      return {
        category: "dns",
        headline: `${host} doesn't resolve (NXDOMAIN)`,
        detail:
          "DNS says the name doesn't exist: the domain may have expired, a record was deleted, or there's a typo.",
        nextSteps: [
          "Check the domain's registration hasn't expired.",
          "Check the DNS record still exists at your DNS provider.",
        ],
      };
    case "dns_servfail":
      return {
        category: "dns",
        headline: `DNS servers for ${host} are failing (SERVFAIL)`,
        detail:
          "The authoritative DNS servers can't answer — often a DNS provider incident or a broken DNSSEC setup.",
        nextSteps: [
          "Check your DNS provider's status page.",
          "If DNSSEC is on, check the DS records and signatures.",
        ],
      };
    case "dns_timeout":
      return {
        category: "dns",
        headline: `DNS lookups for ${host} time out`,
        detail:
          "No DNS server answered in time — usually a DNS provider outage or unreachable name servers.",
        nextSteps: [
          "Check your DNS provider's status page.",
          "Check the domain's NS records point at live servers.",
        ],
      };
    case "dns_no_records":
      return {
        category: "dns",
        headline: `${host} has no address records`,
        detail: "The name exists but has no A/AAAA records, so nothing can connect to it.",
        nextSteps: ["Add or restore the A/AAAA (or CNAME) record at your DNS provider."],
      };
    case "dns_value_mismatch":
      return {
        category: "dns",
        headline: "DNS answer changed",
        detail: `The DNS records for ${host} no longer match the expected values.`,
        nextSteps: ["Check recent DNS changes; a hijack or a mistaken edit both look like this."],
      };
    case "connect_refused":
      return {
        category: "network",
        headline: `Nothing is listening on ${host}`,
        detail:
          "The server is reachable but refuses connections on that port: the service is stopped, crashed, or listens on another port.",
        nextSteps: [
          "Check that the web server / service process is running.",
          "Check the port and any recent firewall or security-group changes.",
        ],
      };
    case "connect_timeout":
      return {
        category: "network",
        headline: `Can't reach ${host}`,
        detail: "Connections time out: the host is down, or a firewall silently drops traffic.",
        nextSteps: [
          "Check the server or load balancer is up.",
          "Check firewall and security-group rules for the port.",
        ],
      };
    case "connect_reset":
      return {
        category: "network",
        headline: "Connection reset",
        detail: `${host} accepted the connection and then dropped it — often a crashing process or an overloaded proxy.`,
        nextSteps: ["Check the server's process and proxy logs around the start time."],
      };
    case "network_unreachable":
      return {
        category: "network",
        headline: `No network route to ${host}`,
        detail:
          "Routing to the address fails, usually a provider network problem or a wrong IP in DNS.",
        nextSteps: [
          "Check the IP in DNS is right.",
          "Check your hosting provider's network status.",
        ],
      };
    case "tls_cert_expired":
      return {
        category: "tls",
        headline: "The TLS certificate has expired",
        detail: "Browsers reject the site until the certificate is renewed.",
        nextSteps: [
          "Renew the certificate and reload the web server.",
          "Check why automatic renewal didn't run.",
        ],
      };
    case "tls_cert_not_yet_valid":
      return {
        category: "tls",
        headline: "The TLS certificate isn't valid yet",
        detail:
          "Its start date is in the future — usually a wrong server clock or a certificate issued for later.",
        nextSteps: ["Check the server clock (NTP).", "Check the certificate's validity dates."],
      };
    case "tls_hostname_mismatch":
      return {
        category: "tls",
        headline: `The certificate doesn't cover ${host}`,
        detail:
          "The server presents a certificate for another name, often after a load balancer or CDN change.",
        nextSteps: [
          "Check which certificate the endpoint serves.",
          "Add the hostname to the certificate or fix the routing.",
        ],
      };
    case "tls_untrusted_chain":
      return {
        category: "tls",
        headline: "Untrusted certificate chain",
        detail: "The certificate chain is incomplete or self-signed, so clients can't verify it.",
        nextSteps: ["Serve the full chain including intermediate certificates."],
      };
    case "tls_handshake_failed":
      return {
        category: "tls",
        headline: "TLS handshake failed",
        detail:
          "Client and server couldn't agree on a secure connection (protocols, ciphers or a broken TLS config).",
        nextSteps: ["Check the TLS configuration and recent changes to it."],
      };
    case "http_status_unexpected":
      return httpExplanation(facts.httpStatus, host);
    case "http_too_many_redirects":
      return {
        category: "http",
        headline: "Redirect loop",
        detail: `${host} keeps redirecting — often an HTTP↔HTTPS or www rule fighting another one.`,
        nextSteps: ["Check redirect rules at the CDN, load balancer and app."],
      };
    case "http_redirect_blocked":
      return {
        category: "config",
        headline: "Redirect to a blocked address",
        detail: "The site redirects to a private or reserved address, which probes never follow.",
        nextSteps: ["Check the redirect target."],
      };
    case "response_timeout":
      return {
        category: "timeout",
        headline: `${host} is too slow to answer`,
        detail: "It accepted the connection but didn't send a full response within the timeout.",
        nextSteps: [
          "Check the app for slow queries or exhausted workers/threads.",
          "Raise the monitor's timeout only if this slowness is expected.",
        ],
      };
    case "keyword_missing":
      return {
        category: "content",
        headline: "Expected text is missing from the page",
        detail:
          "The page loads, but without the keyword — it may show an error page or changed content.",
        nextSteps: ["Open the page and compare it with what the monitor expects."],
      };
    case "keyword_present":
      return {
        category: "content",
        headline: "Unwanted text appeared on the page",
        detail:
          "The page contains text the monitor treats as a failure (for example an error message).",
        nextSteps: ["Open the page to see the error it shows."],
      };
    case "json_invalid":
    case "json_query_failed":
      return {
        category: "content",
        headline: "The API response changed",
        detail: "The response isn't valid JSON or the checked value doesn't match.",
        nextSteps: ["Call the endpoint and compare the response with the monitor's query."],
      };
    case "ws_handshake_failed":
    case "ws_expect_failed":
      return {
        category: "network",
        headline: "WebSocket check failed",
        detail: "The WebSocket upgrade or the expected reply failed.",
        nextSteps: ["Check the WebSocket server and any proxy upgrade settings."],
      };
    case "tcp_expect_failed":
      return {
        category: "content",
        headline: "Unexpected TCP reply",
        detail: "The port is open but the service answered differently than expected.",
        nextSteps: ["Check the service behind the port."],
      };
    case "auth_failed":
      return {
        category: "config",
        headline: `${host} refused the login`,
        detail:
          "The service is reachable but didn't accept the username or password the monitor uses.",
        nextSteps: [
          "Check whether the password was changed or the account removed.",
          "Update the monitor's credentials if they changed on purpose.",
        ],
      };
    case "protocol_error":
      return {
        category: "content",
        headline: `${host} answered, but not as expected`,
        detail:
          "Something is listening on the port, but its answer isn't what this kind of service sends.",
        nextSteps: [
          "Check that the right service runs on this port.",
          "Check whether it is starting up, overloaded or behind a proxy that answers for it.",
        ],
      };
    case "service_unhealthy":
      return {
        category: "content",
        headline: `${host} reports it isn't serving`,
        detail: "The server is up and says the service is not ready to take requests.",
        nextSteps: ["Check the service's own logs and what it depends on (database, queue)."],
      };
    case "ping_loss":
      return {
        category: "network",
        headline: `Packets to ${host} are being lost`,
        detail: "Ping loss is over the threshold — a congested or failing network path or host.",
        nextSteps: ["Check the host and its network provider."],
      };
    case "heartbeat_missed":
      return {
        category: "heartbeat",
        headline: "The job didn't check in",
        detail:
          "No ping arrived in time: the job didn't run, crashed before the ping, or can't reach us.",
        nextSteps: [
          "Check the scheduler (cron, worker) ran the job.",
          "Check the job's logs for an early failure.",
        ],
      };
    case "heartbeat_failed_signal":
      return {
        category: "heartbeat",
        headline: "The job reported a failure",
        detail: "The job pinged its /fail URL or exited with a non-zero code.",
        nextSteps: ["Check the job's logs (the ping's body excerpt may already show the error)."],
      };
    case "ssrf_blocked":
    case "body_too_large":
      return {
        category: "config",
        headline: "The monitor needs a settings change",
        detail:
          "This isn't an outage: the target resolves to a private address or the response is too large to read.",
        nextSteps: ["Edit the monitor (or use a private probe for internal services)."],
      };
    default:
      return {
        category: "unknown",
        headline: "The check failed",
        detail: "The probe couldn't complete the check.",
        nextSteps: ["Open the latest failed check for the full evidence."],
      };
  }
}

export function explainFailure(facts: FailureFacts): Explanation {
  const failing = facts.failingRegions?.length ?? 0;
  const total = facts.totalRegions ?? 0;
  const scope: Explanation["scope"] =
    failing === 0 || total === 0 ? "unknown" : failing >= total ? "everywhere" : "some-regions";
  const base = explainCode(facts);
  const nextSteps =
    scope === "some-regions"
      ? [
          `Only ${facts.failingRegions?.join(", ")} sees it: a network path or regional CDN/edge problem is likely.`,
          ...base.nextSteps,
        ]
      : base.nextSteps;
  return { ...base, nextSteps, scope };
}
