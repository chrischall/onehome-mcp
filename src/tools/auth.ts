import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Compact fingerprint of an auth token so the tool's response confirms
 * what was set without echoing the full value back into the chat
 * transcript. Format: `<first8>…<last4>` for any value longer than 12
 * chars, else `<all>` (short values are unlikely to be real tokens but
 * we surface them so the user sees the parsing didn't lose anything).
 *
 * Prefers the resolved bearer (the JWT we actually use after any
 * checkToken exchange) over the raw input — so a magic-link URL
 * shows a hint of the *token*, not the URL prefix (`https://p…link`).
 */
function fingerprint(input: string, resolvedToken?: string): string {
  const target = (resolvedToken ?? input).trim();
  if (target.length <= 12) return target;
  return `${target.slice(0, 8)}…${target.slice(-4)}`;
}

export function registerAuthTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_set_auth',
    {
      title: 'Register an additional OneHome session at runtime',
      description:
        'Provide a magic-link URL, a raw JWT bearer, or an email-token to ADD another authenticated session to the MCP — useful when a buyer holds shares across multiple agents/MLSes (one magic link per share). The MCP detects the input shape (URL → extract `?token=`; 3-segment JWT → use directly; otherwise → treat as email-token and exchange via `/api/authentication/checkToken`), registers a new direct-bearer transport, and marks it active. Previously-registered sessions stay registered — switch back with `onehome_set_active_session(session_id)`, or let MLS-suffix routing (`~CANOPY`, `~HCAOR`, …) pick automatically per listing. The response includes the assigned `session_id`, the new `active_session_id`, the auth_mode/status, the session_context the checkToken response yielded, and a `bearer_fingerprint` of the resolved JWT (first 8 + `…` + last 4 chars) — never the full bearer. SECURITY: the input itself sits in your chat history; treat magic links as short-lived credentials.',
      annotations: {
        title: 'Register an additional OneHome session at runtime',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        input: z
          .string()
          .min(1)
          .describe(
            'Magic-link URL (https://portal.onehome.com/...?token=eyJ...), JWT bearer (3 dot-separated segments), or raw email-token (single base64 segment).'
          ),
      },
    },
    async ({ input }) => {
      const { sessionId, status, bearer } = await client.setAuthFromInput(input);
      return textResult({
        session_id: sessionId,
        active_session_id: client.getActiveSessionId(),
        auth_mode: status.authMode,
        auth_ready: status.authReady,
        auth_expires_at: status.authExpiresAt,
        session_context: status.sessionContext,
        // Confirms what's now in effect (the resolved bearer, not the
        // raw input) without echoing the secret.
        bearer_fingerprint: fingerprint(input, bearer),
      });
    }
  );

  server.registerTool(
    'onehome_set_active_session',
    {
      title: 'Switch which registered OneHome session is active',
      description:
        'Force a specific registered session to be the active one. Useful when MLS-suffix routing picks the wrong session (e.g. a free-text search across multiple MLSes, or a listing without a `~MLS` suffix). Pass a `session_id` previously returned by `onehome_set_auth` or surfaced in `onehome_get_session_context`. The active session answers any request that doesn\'t carry a `~MLS`-suffixed listing id.',
      annotations: {
        title: 'Switch which registered OneHome session is active',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z
          .string()
          .min(1)
          .describe(
            'Session id from a previous `onehome_set_auth` response, or one of the ids listed by `onehome_get_session_context`.'
          ),
      },
    },
    async ({ session_id }) => {
      client.setActiveSession(session_id);
      return textResult({
        active_session_id: client.getActiveSessionId(),
        sessions: client.listSessions().map((s) => ({
          session_id: s.sessionId,
          auth_mode: s.status.authMode,
          auth_ready: s.status.authReady,
        })),
      });
    }
  );
}
