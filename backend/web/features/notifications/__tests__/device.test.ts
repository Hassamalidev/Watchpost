import { describe, expect, it } from "vitest";
import { deviceName, keyBytes } from "../components/device-card";

describe("device notifications helpers", () => {
  it("names a device from what its browser says", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome on Android");
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
      ),
    ).toBe("Firefox on Windows");
    expect(
      deviceName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      ),
    ).toBe("Edge on macOS");
    expect(deviceName("curl/8")).toBe("Browser on this device");
  });

  it("turns the server key into the 65 bytes a browser subscribes with", () => {
    const key =
      "BLrVuv3J954Nz9YNHKgxiF4gIxkIyHeexqpAV7NixgvxrXXBWggLr7uWh5YMPIoFgXFALJ8NZj8Vlp2fw42A3IM";
    const bytes = keyBytes(key);
    expect(bytes).toHaveLength(65);
    /* An uncompressed P-256 point starts with 0x04. */
    expect(bytes[0]).toBe(4);
  });
});
