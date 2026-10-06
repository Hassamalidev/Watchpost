/* A throwaway CA and leaf certificates for TLS check tests (valid, expired, wrong hostname). */
import selfsigned from "selfsigned";

const DAY = 86_400_000;

export async function createTestCa() {
  const ca = await selfsigned.generate([{ name: "commonName", value: "Watchpost Test CA" }], {
    keyType: "ec",
    algorithm: "sha256",
    notAfterDate: new Date(Date.now() + 30 * DAY),
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });

  async function leaf(options: { host: string; notBefore?: Date; notAfter: Date }) {
    const pems = await selfsigned.generate([{ name: "commonName", value: options.host }], {
      keyType: "ec",
      algorithm: "sha256",
      notBeforeDate: options.notBefore ?? new Date(Date.now() - DAY),
      notAfterDate: options.notAfter,
      ca: { key: ca.private, cert: ca.cert },
      extensions: [
        { name: "subjectAltName", altNames: [{ type: 2, value: options.host }] },
        { name: "extKeyUsage", serverAuth: true },
      ],
    });
    return { key: pems.private, cert: pems.cert };
  }

  return { caCert: ca.cert, leaf };
}
