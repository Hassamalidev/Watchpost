/*
 * Integrations: the catalog's copy is complete, gallery search finds things, setup forms turn text
 * into channel configs (and saved secrets stay untouched), and the screens render from the catalog.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CHANNEL_FIELDS,
  INTEGRATIONS,
  SECRET_MASK,
  channelRulesSchema,
  findIntegration,
  integrationFields,
  type IntegrationDefinition,
} from "@app/shared";
import messages from "@/messages/en.json";
import { renderWithProviders } from "@/test/render";
import {
  DEFAULT_RULES,
  MONOGRAMS,
  defaultRulesFor,
  fieldOfPath,
  initialValues,
  parseHeaderLines,
  rulesSummary,
  searchIntegrations,
  toConfig,
} from "@/features/integrations/catalog";
import { ChannelForm } from "@/features/integrations/components/channel-form";
import { IntegrationGallery } from "@/features/integrations/components/integration-gallery";
import { RulesSummary } from "@/features/integrations/components/parts";

const must = (id: string): IntegrationDefinition => {
  const found = findIntegration(id);
  if (found === undefined) throw new Error(`no integration ${id}`);
  return found;
};

type Copy = Record<string, { label?: string; hint?: string; options?: Record<string, string> }>;

describe("catalog copy", () => {
  it("every integration has a summary, setup steps and a tile", () => {
    const catalog = messages.integrations.catalog as Record<
      string,
      { summary: string; steps: string }
    >;
    for (const integration of INTEGRATIONS) {
      const copy = catalog[integration.id];
      expect(copy?.summary, integration.id).toBeTruthy();
      expect(copy?.steps.split("\n").length, integration.id).toBeGreaterThanOrEqual(2);
      expect(MONOGRAMS[integration.id], integration.id).toBeTruthy();
    }
    expect(Object.keys(catalog).sort()).toEqual(INTEGRATIONS.map((i) => i.id).sort());
  });

  it("every form field has a label, and every select option has one", () => {
    const fields = messages.integrations.fields as Record<string, Copy>;
    for (const [type, list] of Object.entries(CHANNEL_FIELDS)) {
      for (const field of list) {
        const copy = fields[type]?.[field.key];
        expect(copy?.label, `${type}.${field.key}`).toBeTruthy();
        for (const option of field.options ?? []) {
          expect(copy?.options?.[option], `${type}.${field.key}.${option}`).toBeTruthy();
        }
      }
    }
  });
});

describe("gallery search", () => {
  const ids = (query: string, category: Parameters<typeof searchIntegrations>[1] = "all") =>
    searchIntegrations(query, category).map((i) => i.id);

  it("finds integrations by name, keyword and former name", () => {
    expect(ids("pager")).toContain("pagerduty");
    expect(ids("victorops")).toEqual(["splunk-on-call"]);
    expect(ids("integromat")).toEqual(["make"]);
    expect(ids("jsm")).toEqual(["jira-service-management"]);
    expect(ids("SLACK")).toEqual(["slack", "slack-webhook"]);
  });

  it("needs every word to match and respects the category", () => {
    expect(ids("self-hosted push")).toEqual(["ntfy", "gotify"]);
    expect(ids("", "oncall")).toEqual([
      "pagerduty",
      "opsgenie",
      "jira-service-management",
      "splunk-on-call",
    ]);
    expect(ids("slack", "push")).toEqual([]);
    expect(ids("carrier pigeon")).toEqual([]);
    expect(ids("")).toHaveLength(INTEGRATIONS.length);
  });

  it("also searches the translated summary", () => {
    const found = searchIntegrations("adaptive cards", "all", (i) =>
      i.id === "teams" ? "Adaptive Cards in a Teams channel" : "",
    );
    expect(found.map((i) => i.id)).toEqual(["teams"]);
  });
});

describe("setup form values", () => {
  it("builds a config from text, leaving empty optional fields out", () => {
    const zulip = integrationFields(must("zulip"));
    const { config, errors } = toConfig(zulip, {
      serverUrl: " https://acme.zulipchat.com ",
      botEmail: "bot@acme.zulipchat.com",
      apiKey: "secret-key-0123456789",
      stream: "alerts",
      topic: "",
    });
    expect(errors).toEqual({});
    expect(config).toEqual({
      serverUrl: "https://acme.zulipchat.com",
      botEmail: "bot@acme.zulipchat.com",
      apiKey: "secret-key-0123456789",
      stream: "alerts",
    });
  });

  it("splits email lists and applies an entry's preset", () => {
    expect(
      toConfig(integrationFields(must("email")), {
        to: "a@example.com, b@example.com;c@example.com",
      }).config,
    ).toEqual({ to: ["a@example.com", "b@example.com", "c@example.com"] });
    const jsm = must("jira-service-management");
    const config = toConfig(
      integrationFields(jsm),
      { apiKey: "k" },
      jsm.preset ? { preset: jsm.preset } : {},
    ).config;
    expect(config).toEqual({ region: "jsm", apiKey: "k" });
  });

  it("starts from defaults when creating and never shows saved secrets when editing", () => {
    const ntfy = integrationFields(must("ntfy"));
    expect(initialValues(ntfy)).toEqual({
      serverUrl: "https://ntfy.sh",
      topic: "",
      accessToken: "",
    });
    const saved = { serverUrl: "https://ntfy.example.com", topic: "ops", accessToken: SECRET_MASK };
    const values = initialValues(ntfy, saved);
    expect(values).toEqual({
      serverUrl: "https://ntfy.example.com",
      topic: "ops",
      accessToken: "",
    });
    /* An untouched secret is left out, which the API reads as "keep it". */
    expect(toConfig(ntfy, values).config).toEqual({
      serverUrl: "https://ntfy.example.com",
      topic: "ops",
    });
    expect(toConfig(ntfy, values, { removed: new Set(["accessToken"]) }).config.accessToken).toBe(
      null,
    );
  });

  it("parses header lines, keeps masked values and reports lines it can't read", () => {
    expect(parseHeaderLines("Authorization: Bearer a:b\n\n X-Team : ops ")).toEqual({
      headers: { Authorization: "Bearer a:b", "X-Team": "ops" },
      invalid: [],
    });
    expect(parseHeaderLines("no colon\nEmpty:").invalid).toEqual(["no colon", "Empty:"]);
    const webhook = integrationFields(must("webhook"));
    const values = initialValues(webhook, {
      url: "https://hooks.example.com/in",
      secret: "whsec_x",
      headers: { Authorization: SECRET_MASK },
    });
    expect(values.headers).toBe(`Authorization: ${SECRET_MASK}`);
    expect(toConfig(webhook, values).config).toEqual({
      url: "https://hooks.example.com/in",
      headers: { Authorization: SECRET_MASK },
    });
    expect(toConfig(webhook, { url: "https://x.example", headers: "broken" }).errors).toEqual({
      headers: "headers",
    });
  });

  it("maps API error paths to form fields", () => {
    expect(fieldOfPath("body.config.routingKey")).toBe("routingKey");
    expect(fieldOfPath("body.config.headers.X-Team")).toBe("headers");
    expect(fieldOfPath("body.name")).toBe("name");
    expect(fieldOfPath("body.type")).toBeUndefined();
  });
});

describe("channel rules", () => {
  it("on-call tools start with high and critical only; the rest take everything", () => {
    expect(defaultRulesFor(must("pagerduty")).minSeverity).toBe("high");
    expect(defaultRulesFor(must("splunk-on-call")).minSeverity).toBe("high");
    expect(defaultRulesFor(must("slack-webhook"))).toEqual(DEFAULT_RULES);
    expect(channelRulesSchema.parse({})).toEqual(DEFAULT_RULES);
  });

  it("are summed up in a few words", () => {
    expect(rulesSummary(DEFAULT_RULES)).toBeNull();
    const rules = channelRulesSchema.parse({
      minSeverity: "high",
      events: { reminder: false, flapping: false },
    });
    expect(rulesSummary(rules)).toEqual({ severity: "high", without: ["reminder", "flapping"] });
    const { container } = renderWithProviders(<RulesSummary rules={rules} />);
    expect(container).toHaveTextContent("High and critical · no reminders · no flapping notices");
    expect(renderWithProviders(<RulesSummary rules={DEFAULT_RULES} />).container).toHaveTextContent(
      "All alerts",
    );
  });
});

describe("IntegrationGallery", () => {
  it("lists every integration, filters as you type and by category", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntegrationGallery ws="ws1" availability={undefined} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(INTEGRATIONS.length);
    expect(screen.getByRole("link", { name: /PagerDuty/ })).toHaveAttribute(
      "href",
      "/w/ws1/integrations/new/pagerduty",
    );

    await user.type(screen.getByRole("searchbox", { name: "Search integrations" }), "push");
    expect(
      screen.getAllByRole("listitem").map((li) => within(li).getByRole("heading").textContent),
    ).toEqual(["Pushover", "ntfy", "Pushbullet", "Gotify"]);
    expect(screen.getByText("4 integrations")).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox"));
    await user.click(screen.getByRole("button", { name: "On-call" }));
    expect(screen.getByRole("button", { name: "On-call" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("offers a webhook when nothing matches, and marks what the server can't deliver to", async () => {
    const user = userEvent.setup();
    renderWithProviders(<IntegrationGallery ws="ws1" availability={new Map([["slack", false]])} />);
    expect(
      within(screen.getByRole("link", { name: /^Slack Chat/ })).getByText(
        "Not set up on this server",
      ),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox"), "fax machine");
    expect(screen.getByText("No integration matches “fax machine”.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up a webhook" })).toHaveAttribute(
      "href",
      "/w/ws1/integrations/new/webhook",
    );
  });
});

describe("ChannelForm", () => {
  afterEach(() => vi.unstubAllGlobals());

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("renders the integration's fields and sends the config with on-call default rules", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
      json(201, { id: "c1", type: "pagerduty", ...(JSON.parse(String(init?.body)) as object) }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSaved = vi.fn();
    renderWithProviders(
      <ChannelForm ws="ws1" integration={must("pagerduty")} submitLabel="Save" onSaved={onSaved} />,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("PagerDuty");
    expect(screen.getByLabelText("Incidents")).toHaveValue("high");
    await user.type(screen.getByLabelText("Integration key"), "a".repeat(32));
    await user.selectOptions(screen.getByLabelText("Region"), "eu");
    await user.click(screen.getByRole("checkbox", { name: "Reminders while down" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/w/ws1/channels");
    expect(JSON.parse(String(init?.body))).toEqual({
      type: "pagerduty",
      name: "PagerDuty",
      config: { routingKey: "a".repeat(32), region: "eu" },
      rules: {
        minSeverity: "high",
        events: {
          triggered: true,
          acknowledged: true,
          resolved: true,
          reminder: false,
          flapping: true,
        },
      },
    });
  });

  it("shows the API's field errors next to the inputs", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(400, {
          code: "validation_failed",
          detail: "Gotify: appToken is required",
          errors: [{ path: "body.config.appToken", message: "is required" }],
        }),
      ),
    );
    renderWithProviders(
      <ChannelForm ws="ws1" integration={must("gotify")} submitLabel="Save" onSaved={vi.fn()} />,
    );
    await user.type(screen.getByLabelText("Server URL"), "https://gotify.example.com");
    /* The browser's own "required" check would stop the submit; send it as the API would see it. */
    screen.getByLabelText("Application token").removeAttribute("required");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const token = await screen.findByLabelText("Application token");
    await waitFor(() => expect(token).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByRole("alert")).toHaveTextContent("is required");
  });

  it("when editing, saved secrets stay empty and are kept unless changed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) =>
      json(200, {
        id: "c9",
        type: "ntfy",
        ...(JSON.parse(String(init?.body)) as object),
        config: { serverUrl: "https://ntfy.sh", topic: "ops-2", accessToken: SECRET_MASK },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderWithProviders(
      <ChannelForm
        ws="ws1"
        integration={must("ntfy")}
        channel={{
          id: "c9",
          type: "ntfy",
          name: "Phone",
          status: "healthy",
          integration: "ntfy",
          rules: DEFAULT_RULES,
          lastSuccessAt: null,
          lastFailureAt: null,
          lastError: null,
          config: { serverUrl: "https://ntfy.sh", topic: "ops", accessToken: SECRET_MASK },
        }}
        submitLabel="Save"
        onSaved={vi.fn()}
      />,
    );
    const token = screen.getByLabelText("Access token (optional)");
    expect(token).toHaveValue("");
    expect(token).toHaveAccessibleDescription(/Saved\. Leave empty to keep it\./);
    expect(screen.getByRole("checkbox", { name: "Remove the saved value" })).not.toBeChecked();

    await user.clear(screen.getByLabelText("Topic"));
    await user.type(screen.getByLabelText("Topic"), "ops-2");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/w/ws1/channels/c9");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body)).config).toEqual({
      serverUrl: "https://ntfy.sh",
      topic: "ops-2",
    });
  });
});
