/* Multi-step API checks in the monitor form: the steps box, the secrets box, and what is sent. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMonitorSchema } from "@app/shared";
import { renderWithProviders } from "@/test/render";
import { targetOf } from "@/features/monitors/api";
import { MonitorForm, parseSecretLines } from "@/features/monitors/components/monitor-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => vi.unstubAllGlobals());

describe("secrets as lines", () => {
  it("reads name=value, keeping any = in the value", () => {
    expect(parseSecretLines("password=hunter2\n\n apiKey = a=b=c \nbare")).toEqual([
      { name: "password", value: "hunter2" },
      { name: "apiKey", value: " a=b=c" },
      { name: "bare", value: "" },
    ]);
    expect(parseSecretLines("")).toEqual([]);
  });
});

describe("a multi-step monitor in lists", () => {
  it("is described by where it starts and how many steps it has", () => {
    expect(
      targetOf({
        config: {
          type: "multistep",
          steps: [{ url: "https://api.example.com/login" }, { url: "https://api.example.com/me" }],
        },
      }),
    ).toBe("https://api.example.com (2)");
  });
});

describe("MonitorForm, multi-step", () => {
  function show() {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST" && String(url).endsWith("/monitors")) {
          sent.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ id: "m1" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderWithProviders(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <MonitorForm ws="ws1" />
      </QueryClientProvider>,
    );
    return sent;
  }

  it("starts from an example that is valid once its secret is given, and sends it", async () => {
    const sent = show();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type"), "multistep");
    await user.type(screen.getByLabelText("Name"), "Login flow");
    expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    const steps = screen.getByLabelText("Steps (JSON)") as HTMLTextAreaElement;
    expect(JSON.parse(steps.value)).toHaveLength(2);

    /* Without the secret the example refers to, the form says what is missing. */
    await user.click(screen.getByRole("button", { name: /create|save/i }));
    expect(await screen.findByText(/\{\{password\}\} has no value yet/)).toBeInTheDocument();
    expect(sent).toEqual([]);

    await user.type(screen.getByLabelText("Secrets"), "password=hunter2-pass");
    await user.click(screen.getByRole("button", { name: /create|save/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0] as { config: { type: string; steps: unknown[]; secrets: unknown[] } };
    expect(body.config.type).toBe("multistep");
    expect(body.config.secrets).toEqual([{ name: "password", value: "hunter2-pass" }]);
    expect(createMonitorSchema.safeParse(body).success).toBe(true);
  });

  it("says so when the steps aren't JSON", async () => {
    const sent = show();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type"), "multistep");
    await user.type(screen.getByLabelText("Name"), "Broken");
    fireEvent.change(screen.getByLabelText("Steps (JSON)"), { target: { value: "[{ not json" } });
    await user.click(screen.getByRole("button", { name: /create|save/i }));
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Steps (JSON)")).toHaveAttribute("aria-invalid", "true"),
    );
    expect(sent).toEqual([]);
  });
});
