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

export const SEVERITIES = ["critical", "high", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
