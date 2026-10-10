/*
 * Check implementations by monitor type (PRODUCT.md §6.1). Domain expiry and heartbeats are driven by
 * the API, not probes; types missing here are reported as probe_error by the executor.
 */
import type { CheckRunners } from "../executor/executor.js";
import { runDns } from "./dns.js";
import { runHttp, runJsonQuery, runKeyword } from "./http.js";
import { runMultistep } from "./multistep.js";
import { runPing } from "./ping.js";
import { runGrpc, runMqtt, runRedis } from "./protocols.js";
import { runSsl } from "./ssl.js";
import { runTcp } from "./tcp.js";
import { runWebSocket } from "./websocket.js";

export const defaultCheckRunners: CheckRunners = {
  http: runHttp,
  keyword: runKeyword,
  json_query: runJsonQuery,
  multistep: runMultistep,
  tcp: runTcp,
  ping: runPing,
  dns: runDns,
  websocket: runWebSocket,
  ssl: runSsl,
  redis: runRedis,
  mqtt: runMqtt,
  grpc: runGrpc,
};
