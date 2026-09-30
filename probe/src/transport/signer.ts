/* HMAC request signing (PRODUCT.md §7.6), shared string format from @app/shared. */
import { createHash, createHmac } from "node:crypto";
import { PROBE_HEADERS, probeSigningString } from "@app/shared";

export function sha256Hex(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

export function signRequest(input: {
  probeId: string;
  secret: string;
  method: string;
  path: string;
  body: string;
  nowMs: number;
}): Record<string, string> {
  const timestamp = String(Math.floor(input.nowMs / 1_000));
  const signature = createHmac("sha256", input.secret)
    .update(
      probeSigningString({
        timestamp,
        method: input.method,
        path: input.path,
        bodySha256Hex: sha256Hex(input.body),
      }),
    )
    .digest("hex");
  return {
    [PROBE_HEADERS.id]: input.probeId,
    [PROBE_HEADERS.timestamp]: timestamp,
    [PROBE_HEADERS.signature]: signature,
  };
}
