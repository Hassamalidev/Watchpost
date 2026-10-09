/* An agency's client workspaces in Settings: the list, creating one, and the plan's refusal. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { ClientWorkspaces } from "@/features/settings/components/client-workspaces";

afterEach(() => vi.unstubAllGlobals());

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithProviders(
    <QueryClientProvider client={client}>
      <ClientWorkspaces ws="agency" />
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status < 400 ? "application/json" : "application/problem+json" },
  });

describe("ClientWorkspaces", () => {
  it("lists clients with a link into each, and adds a new one", async () => {
    const clients = [{ id: "c1", name: "Bakery", createdAt: "2026-10-09T00:00:00.000Z" }];
    const posted: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { name: string };
          posted.push(body);
          const made = { id: "c2", name: body.name, createdAt: "2026-10-09T00:00:00.000Z" };
          clients.push(made);
          return json(made, 201);
        }
        return json({ data: clients });
      }),
    );
    const user = userEvent.setup();
    show();
    expect(await screen.findByRole("link", { name: "Open Bakery" })).toHaveAttribute(
      "href",
      "/w/c1",
    );
    const create = screen.getByRole("button", { name: "Create client workspace" });
    expect(create).toBeDisabled();
    await user.type(screen.getByLabelText("Client name"), " Florist ");
    await user.click(create);
    expect(await screen.findByRole("link", { name: "Open Florist" })).toHaveAttribute(
      "href",
      "/w/c2",
    );
    expect(posted).toEqual([{ name: "Florist" }]);
    expect(screen.getByLabelText("Client name")).toHaveValue("");
  });

  it("says so when there are none, and shows why the plan refuses one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? json(
              {
                status: 402,
                code: "quota_exceeded",
                detail: "Client workspaces are part of the Business plan.",
              },
              402,
            )
          : json({ data: [] }),
      ),
    );
    const user = userEvent.setup();
    show();
    expect(await screen.findByText("No client workspaces yet.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Client name"), "Bakery");
    await user.click(screen.getByRole("button", { name: "Create client workspace" }));
    expect(
      await screen.findByText("Client workspaces are part of the Business plan."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Client name")).toHaveValue("Bakery");
  });
});
