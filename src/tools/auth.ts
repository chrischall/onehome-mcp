import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';

/**
 * Compact fingerprint of an auth input so the tool's response confirms
 * what was set without echoing the full token back into the chat
 * transcript. Format: `<first8>…<last4>` for any input longer than 12
 * chars, else `<all>` (short inputs are unlikely to be real tokens but
 * we surface them so the user sees the parsing didn't lose anything).
 */
function fingerprint(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`;
}

export function registerAuthTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_set_auth',
    {
      title: 'Set the OneHome bearer at runtime',
      description:
        'Provide a magic-link URL, a raw JWT bearer, or an email-token to authenticate the MCP mid-session — useful when the host was launched without `ONEHOME_TOKEN` / `ONEHOME_MAGIC_LINK` env vars and the fetchproxy capture path is unavailable. The MCP detects the input shape (URL → extract `?token=`; 3-segment JWT → use directly; otherwise → treat as email-token and exchange via `/api/authentication/checkToken`), swaps its transport to a direct bearer-attached client, and returns the new auth status. The response includes only a token fingerprint (first 8 + last 4 chars) and the parsed account email — never the full bearer — so the chat transcript stays clean. SECURITY: the input itself sits in your chat history; treat magic links as short-lived credentials and prefer setting the env var when you control the host config. Read-only-on-network in the sense that it does not mutate the OneHome account; it does mutate this MCP\'s internal state (so it\'s marked destructive).',
      annotations: {
        title: 'Set the OneHome bearer at runtime',
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
      const status = await client.setAuthFromInput(input);
      return textResult({
        auth_mode: status.authMode,
        auth_ready: status.authReady,
        auth_expires_at: status.authExpiresAt,
        session_context: status.sessionContext,
        // Confirms what was set without echoing the secret.
        input_fingerprint: fingerprint(input),
      });
    }
  );
}
