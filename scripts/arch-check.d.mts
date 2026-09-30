/* Types for scripts/arch-check.mjs, used by the architecture tests. */
export interface ArchViolation {
  from: string;
  to: string;
  rule: { name: string; severity: string };
  cycle?: Array<{ name: string }>;
}

export interface ArchProject {
  files: string[];
  tsConfig: string;
}

export const REPO_ROOT: string;
export const DEFAULT_PROJECTS: ArchProject[];

export function checkArchitecture(options?: {
  baseDir?: string;
  projects?: ArchProject[];
}): Promise<{ violations: ArchViolation[]; modules: number; report: string }>;
