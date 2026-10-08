/* Probe regions (PRODUCT.md §7.8). The first three launch in P2; the rest in P8. */
export const REGIONS = [
  "eu-central",
  "us-east",
  "ap-southeast",
  "ap-south",
  "me-central",
  "eu-west",
  "us-west",
  "sa-east",
  "ap-southeast-2",
] as const;

export type Region = (typeof REGIONS)[number];

export const LAUNCH_REGIONS: readonly Region[] = ["eu-central", "us-east", "ap-southeast"];

/*
 * A private probe (PRODUCT.md §4 "Inside and outside your network") is a location of its own, named
 * after the probe: `private:<probe ID>`. Wherever a region is stored (a monitor's regions, a
 * result, a verification task) a private location can stand instead.
 */
export const PRIVATE_REGION_PREFIX = "private:";
const PRIVATE_REGION = /^private:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const privateRegionOf = (probeId: string) =>
  `${PRIVATE_REGION_PREFIX}${probeId.toLowerCase()}`;
export const isPrivateRegion = (region: string) => PRIVATE_REGION.test(region);
/* The probe's ID, or undefined for a public region. */
export const privateProbeIdOf = (region: string) =>
  isPrivateRegion(region) ? region.slice(PRIVATE_REGION_PREFIX.length) : undefined;

export const SEVERITIES = ["critical", "high", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
