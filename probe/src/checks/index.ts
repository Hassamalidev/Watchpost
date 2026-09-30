/*
 * Check implementations by monitor type. Executors arrive in P1-T07 (HTTP, keyword, JSON query, TCP,
 * DNS, WebSocket, ping, TLS); until then the executor reports probe_error for unknown types.
 */
import type { CheckRunners } from "../executor/executor.js";

export const defaultCheckRunners: CheckRunners = {};
