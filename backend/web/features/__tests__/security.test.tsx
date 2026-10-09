/* Two-factor sign-in set-up and the device list's names. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { deviceName } from "@/features/security/components/security-page";
import { TwoFactorCard } from "@/features/security/components/two-factor-card";

afterEach(() => vi.unstubAllGlobals());

describe("TwoFactorCard", () => {
  it("asks for the password, shows the setup key, and gives the backup codes once a code is proved", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
        const answer = url.endsWith("/two-factor/enable")
          ? {
              totpURI: "otpauth://totp/App:sara%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=App",
              backupCodes: ["aaaa-1111", "bbbb-2222"],
            }
          : { status: true };
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<TwoFactorCard enabled={false} onChanged={onChanged} />);
    expect(screen.getByText("Two-factor sign-in is off.")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Set up two-factor sign-in" });
    expect(start).toBeDisabled();
    await user.type(screen.getByLabelText("Your password"), "correct horse");
    await user.click(start);

    /* The key from the link, for typing into an authenticator app. */
    expect(await screen.findByLabelText("Setup key")).toHaveValue("JBSWY3DPEHPK3PXP");
    expect(calls[0]).toEqual({
      url: "/api/auth/two-factor/enable",
      body: { password: "correct horse" },
    });
    expect(onChanged).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Code from the app"), "123456");
    await user.click(screen.getByRole("button", { name: "Confirm and switch on" }));

    expect(await screen.findByLabelText("Backup codes")).toHaveValue("aaaa-1111 bbbb-2222");
    expect(calls[1]).toEqual({ url: "/api/auth/two-factor/verify-totp", body: { code: "123456" } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says why when the password is wrong, and stays where it was", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Invalid password" }), {
            status: 400,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<TwoFactorCard enabled onChanged={vi.fn()} />);
    expect(screen.getByText("Two-factor sign-in is on.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Your password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Switch off two-factor sign-in" }));
    expect(await screen.findByText("Invalid password")).toBeInTheDocument();
    expect(screen.getByText("Two-factor sign-in is on.")).toBeInTheDocument();
  });
});

describe("deviceName", () => {
  it("names the browser and the system", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0",
      ),
    ).toBe("Edge on Windows");
    expect(
      deviceName("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0"),
    ).toBe("Firefox on Linux");
    expect(deviceName(null)).toBe("Unknown device");
  });
});
