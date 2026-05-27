import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { GraphQLResponseError } from '../client.js';
import {
  buildGetOneHomeUser,
  buildGetSavedSearchBySearchId,
} from '../queries.js';

/**
 * End-to-end smoke test for the onehome-mcp setup.
 *
 * Strategy:
 *   - Magic-link session context has a `savedSearchId` → probe
 *     `GetSavedSearchBySearchId`. This works for consumer-share
 *     sessions, where `user { }` is access-denied.
 *   - No saved-search id → probe `GetOneHomeUser`. Works for agent /
 *     registered accounts.
 *
 * Either way we return a structured report covering auth source,
 * token expiry, session scope, and the round-trip result. Drives
 * "is auth wired up?" debugging without forcing the caller to try
 * each tool by hand.
 */

type ProbeKind = 'GetSavedSearchBySearchId' | 'GetOneHomeUser';

interface HealthcheckResult {
  ok: boolean;
  auth: {
    mode: 'env_token' | 'magic_link' | 'fetchproxy_capture';
    ready: boolean;
    expires_at: number | null;
    expires_at_iso?: string;
    seconds_until_expiry: number | null;
  };
  session_context: Record<string, unknown>;
  bridge?: {
    role: 'host' | 'peer' | null;
    port: number;
    server_version: string;
    /**
     * 0.8.0+: unix-ms of the most recent message the fetchproxy bridge
     * heard from the browser extension. Null if the extension has
     * never spoken. Useful for diagnosing "is the extension still
     * connected?" between captures.
     */
    last_extension_message_at: number | null;
    last_extension_message_at_iso?: string;
  };
  probe: {
    operation: ProbeKind;
    elapsed_ms: number;
    detail?: string;
  };
  last_success_at: number | null;
  last_failure_at: number | null;
  last_failure_reason: string | null;
  consecutive_failures: number;
  error?: {
    kind: 'transport' | 'graphql' | 'timeout' | 'other';
    message: string;
  };
  hint: string;
}

function hintFor(args: {
  ok: boolean;
  mode: 'env_token' | 'magic_link' | 'fetchproxy_capture';
  errorKind?: 'transport' | 'graphql' | 'timeout' | 'other';
  secondsUntilExpiry: number | null;
}): string {
  if (args.ok) {
    if (
      args.secondsUntilExpiry !== null &&
      args.secondsUntilExpiry < 60 * 60
    ) {
      return `Auth round-tripped, but the token expires in under an hour. Refresh ${
        args.mode === 'magic_link' ? 'ONEHOME_MAGIC_LINK' : 'ONEHOME_TOKEN'
      } soon.`;
    }
    return 'Auth + GraphQL round-tripped successfully. The MCP is ready.';
  }
  if (args.errorKind === 'graphql') {
    return 'GraphQL came back with errors — inspect `error.message` for the upstream message. Common cause: the session has a different access scope than expected (consumer vs agent).';
  }
  if (args.mode === 'fetchproxy_capture') {
    return 'Auth-capture mode: make sure the fetchproxy browser extension is installed and paired, you have portal.onehome.com signed in, and interact with the page (move the map, click a pin, etc.) to trigger a GraphQL call that we can capture the Authorization header from.';
  }
  return 'GraphQL round-trip failed. Refresh ONEHOME_TOKEN / ONEHOME_MAGIC_LINK and retry; if it keeps failing, run `onehome_graphql` to inspect the raw error envelope.';
}

export function registerHealthcheckTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_healthcheck',
    {
      title: 'Verify OneHome auth + GraphQL reachability',
      description:
        'Round-trip a minimal authenticated query through the configured transport. Picks `GetSavedSearchBySearchId` for magic-link consumer-shares (works for them) or `GetOneHomeUser` for agent/registered sessions. Returns the auth mode, token expiry, fetchproxy bridge role (when applicable), elapsed time, and any error detail. Run this first when a tool fails — it isolates "is auth wired up?" from "is the API itself misbehaving?".',
      annotations: {
        title: 'Verify OneHome auth + GraphQL reachability',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      const status = client.bridgeStatus();
      const ctx = status.sessionContext;
      const probe: ProbeKind = ctx.savedSearchId
        ? 'GetSavedSearchBySearchId'
        : 'GetOneHomeUser';
      const start = Date.now();
      let ok = false;
      let detail: string | undefined;
      let errorKind: 'transport' | 'graphql' | 'timeout' | 'other' | undefined;
      let errorMessage: string | undefined;
      try {
        if (probe === 'GetSavedSearchBySearchId') {
          const data = await client.graphql<{
            savedSearch?: { id?: string; name?: string };
          }>(buildGetSavedSearchBySearchId(ctx.savedSearchId!));
          ok = true;
          detail = data.savedSearch?.name
            ? `saved search "${data.savedSearch.name}"`
            : undefined;
        } else {
          const data = await client.graphql<{
            user?: { email?: string; firstName?: string; lastName?: string };
          }>(buildGetOneHomeUser());
          ok = true;
          if (data.user) {
            const name = [data.user.firstName, data.user.lastName]
              .filter(Boolean)
              .join(' ');
            detail = name || data.user.email;
          }
        }
      } catch (err) {
        if (err instanceof GraphQLResponseError) {
          errorKind = 'graphql';
        } else if (err instanceof Error && /timed out/i.test(err.message)) {
          errorKind = 'timeout';
        } else if (
          err instanceof Error &&
          /(network|fetch failed|getaddrinfo)/i.test(err.message)
        ) {
          errorKind = 'transport';
        } else {
          errorKind = 'other';
        }
        errorMessage = err instanceof Error ? err.message : String(err);
      }
      const elapsed = Date.now() - start;
      const secondsUntilExpiry =
        status.authExpiresAt !== null
          ? Math.round((status.authExpiresAt - Date.now()) / 1000)
          : null;
      const result: HealthcheckResult = {
        ok,
        auth: {
          mode: status.authMode,
          ready: status.authReady,
          expires_at: status.authExpiresAt,
          ...(status.authExpiresAt !== null
            ? { expires_at_iso: new Date(status.authExpiresAt).toISOString() }
            : {}),
          seconds_until_expiry: secondsUntilExpiry,
        },
        session_context: { ...ctx },
        ...(status.fetchproxy
          ? {
              bridge: {
                role: status.fetchproxy.role,
                port: status.fetchproxy.port,
                server_version: status.fetchproxy.serverVersion,
                last_extension_message_at:
                  status.fetchproxy.lastExtensionMessageAt,
                ...(status.fetchproxy.lastExtensionMessageAt !== null
                  ? {
                      last_extension_message_at_iso: new Date(
                        status.fetchproxy.lastExtensionMessageAt
                      ).toISOString(),
                    }
                  : {}),
              },
            }
          : {}),
        probe: {
          operation: probe,
          elapsed_ms: elapsed,
          ...(detail ? { detail } : {}),
        },
        last_success_at: status.lastSuccessAt,
        last_failure_at: status.lastFailureAt,
        last_failure_reason: status.lastFailureReason,
        consecutive_failures: status.consecutiveFailures,
        ...(errorMessage
          ? { error: { kind: errorKind ?? 'other', message: errorMessage } }
          : {}),
        hint: hintFor({
          ok,
          mode: status.authMode,
          errorKind,
          secondsUntilExpiry,
        }),
      };
      return textResult(result);
    }
  );
}
