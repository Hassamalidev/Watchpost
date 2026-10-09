/* Settings, "Your data": the download and the two sides of deleting a workspace. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { WorkspaceData } from "@/features/settings/components/workspace-data";

afterEach(() => vi.unstubAllGlobals());

const NONE = { scheduled: false, requestedAt: null, requestedBy: null, deleteAfter: null };
const WAITING = {
  scheduled: true,
  requestedAt: "2026-10-09T12:00:00.000Z",
  requestedBy: "sara@example.com",
  deleteAfter: "2026-11-08T12:00:00.000Z",
};

function show(isOwner: boolean, start: typeof NONE | typeof WAITING) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const answer = url.endsWith("/privacy/export")
        ? { version: 1, exportedAt: "2026-10-09T12:00:00.000Z", monitors: [] }
        : method === "POST"
          ? WAITING
          : method === "DELETE"
            ? NONE
            : start;
      return new Response(JSON.stringify(answer), {
        status: method === "POST" ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  renderWithProviders(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceData ws="ws1" name="Acme" isOwner={isOwner} />
    </QueryClientProvider>,
  );
  return calls;
}

describe("WorkspaceData", () => {
  it("downloads the workspace as a file", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return "blob:test";
      },
      revokeObjectURL: () => undefined,
    });
    const calls = show(false, NONE);
    await userEvent.setup().click(screen.getByRole("button", { name: "Download workspace data" }));
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]?.type).toBe("application/json");
    expect(calls.some((call) => call.url.endsWith("/api/w/ws1/privacy/export"))).toBe(true);
  });

  it("lets an owner delete the workspace only after typing its name", async () => {
    const calls = show(true, NONE);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "Delete this workspace" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Workspace name, to confirm"), "Acm");
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Workspace name, to confirm"), "e");
    await user.click(button);
    expect(await screen.findByText(/This workspace will be erased after/)).toHaveTextContent(
      "sara@example.com asked for it.",
    );
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ confirm: "Acme" });

    await user.click(screen.getByRole("button", { name: "Cancel the deletion" }));
    expect(await screen.findByLabelText("Workspace name, to confirm")).toHaveValue("");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  it("shows an admin the state, without the means to change it", async () => {
    show(false, WAITING);
    expect(await screen.findByText(/This workspace will be erased after/)).toBeInTheDocument();
    expect(screen.getByText("An owner can cancel the deletion.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel the deletion" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace name, to confirm")).not.toBeInTheDocument();
  });

  it("tells an admin that deleting is for owners", async () => {
    show(false, NONE);
    expect(await screen.findByText("Only an owner can delete the workspace.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace name, to confirm")).not.toBeInTheDocument();
  });
});
