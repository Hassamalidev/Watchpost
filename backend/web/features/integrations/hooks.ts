/* TanStack Query hooks for integrations. */
"use client";

import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CHANNEL_CAPABILITIES, type IntegrationDefinition } from "@app/shared";
import { workspaceHref } from "@/lib/navigation";
import {
  addToDefaultPolicy,
  integrationKeys,
  integrationsApi,
  type ChannelDetail,
  type SetupOutcome,
  type TestResult,
} from "./api";

/* Which channel types this server can deliver to; it changes only with the server's config. */
export function useChannelTypes(ws: string) {
  return useQuery({
    queryKey: integrationKeys.types(ws),
    queryFn: async () => (await integrationsApi.channelTypes(ws)).data,
    staleTime: 5 * 60_000,
  });
}

/*
 * Finishes a new channel: adds it to the default alert policy, sends a test alert when that is
 * harmless (tools that page people are tested by hand, with a warning), remembers the outcome for the
 * channel's page and goes there.
 */
export function useFinishSetup(ws: string, integration: IntegrationDefinition) {
  const router = useRouter();
  const client = useQueryClient();
  return async (channel: ChannelDetail, options: { test: boolean }) => {
    /* The channel exists from here on, so nothing below may fail the form: it would be created twice. */
    let routingError: string | null = null;
    try {
      await addToDefaultPolicy(ws, channel.id);
    } catch (err) {
      routingError = err instanceof Error ? err.message : String(err);
    }
    let test: TestResult | null = null;
    if (options.test && !CHANNEL_CAPABILITIES[integration.type].testPages) {
      try {
        test = await integrationsApi.sendTest(ws, channel.id);
      } catch (err) {
        test = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    client.setQueryData<SetupOutcome>(integrationKeys.setup(ws, channel.id), {
      test,
      routingError,
    });
    await Promise.all([
      client.invalidateQueries({ queryKey: integrationKeys.channels(ws) }),
      client.invalidateQueries({ queryKey: integrationKeys.policies(ws) }),
    ]);
    router.push(workspaceHref(ws, `integrations/${channel.id}`));
  };
}
