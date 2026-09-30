import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/components/app/theme-toggle";
import { renderWithProviders } from "@/test/render";

describe("ThemeToggle", () => {
  it("cycles light → dark → system and applies the dark class", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ThemeToggle />);

    const button = await screen.findByRole("button", { name: /Toggle theme: Light/ });
    await user.click(button);
    expect(await screen.findByRole("button", { name: /Toggle theme: Dark/ })).toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");

    await user.click(screen.getByRole("button", { name: /Toggle theme: Dark/ }));
    expect(await screen.findByRole("button", { name: /Toggle theme: System/ })).toBeInTheDocument();
  });
});
