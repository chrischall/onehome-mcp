import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { GraphQLResponseError } from '../client.js';
import { buildGetOneHomeUser } from '../queries.js';

interface RawUserAgent {
  id?: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  officeName?: string;
  officePhone?: string;
  teamName?: string;
  mls?: { mlsid?: string };
}

interface RawUserGroup {
  id?: string;
  firstName?: string;
  lastName?: string;
  contactId?: string;
  emails?: string[];
  contactStatus?: string;
  createdAt?: string;
  shareToken?: string;
  agent?: RawUserAgent;
}

interface UserResponse {
  user?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    registered?: boolean;
    lastAccessedGroupId?: string;
    lastAccessedSavedSearchId?: string;
    userWelcomed?: boolean;
    groups?: RawUserGroup[];
  };
}

function formatGroup(g: RawUserGroup): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (g.id) out.group_id = g.id;
  if (g.firstName || g.lastName) {
    out.consumer_name = [g.firstName, g.lastName].filter(Boolean).join(' ');
  }
  if (g.contactId) out.contact_id = g.contactId;
  if (g.emails && g.emails.length > 0) out.emails = g.emails;
  if (g.contactStatus) out.contact_status = g.contactStatus;
  if (g.createdAt) out.created_at = g.createdAt;
  if (g.agent) {
    const a = g.agent;
    out.agent = {
      id: a.id,
      name: a.fullName ?? [a.firstName, a.lastName].filter(Boolean).join(' '),
      email: a.email,
      phone: a.phone,
      office: a.officeName,
      office_phone: a.officePhone,
      team: a.teamName,
      mls_id: a.mls?.mlsid,
    };
  }
  return out;
}

/**
 * GraphQL `user { ... }` is agent-only — consumer-share sessions get
 * "Access Denied". We detect that and fall back to the data already
 * captured during the `checkToken` exchange (email, contact id, group
 * id, etc.).
 */
function isAccessDenied(err: unknown): boolean {
  if (!(err instanceof GraphQLResponseError)) return false;
  return err.errors.some((e) => /access denied/i.test(e.message ?? ''));
}

export function registerUserTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_user',
    {
      title: 'Get the signed-in OneHome user profile',
      description:
        'Returns the OneHome user profile + the consumer-share groups attached. For full agent / registered users, queries the GraphQL `user` endpoint. For magic-link consumer-share sessions (where `user { }` is access-denied), falls back to the data captured during the `checkToken` exchange — email, contact id, group/savedSearch ids, and the agent who shared with you.',
      annotations: {
        title: 'Get the signed-in OneHome user profile',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.graphql<UserResponse>(buildGetOneHomeUser());
        const u = data.user;
        if (!u) return textResult(null);
        const groups = (u.groups ?? []).map(formatGroup);
        return textResult({
          source: 'graphql',
          user_id: u.id,
          first_name: u.firstName,
          last_name: u.lastName,
          email: u.email,
          phone: u.phone,
          registered: u.registered,
          last_accessed_group_id: u.lastAccessedGroupId,
          last_accessed_saved_search_id: u.lastAccessedSavedSearchId,
          user_welcomed: u.userWelcomed,
          groups,
        });
      } catch (err) {
        if (!isAccessDenied(err)) throw err;
        const ctx = client.bridgeStatus().sessionContext;
        return textResult({
          source: 'session_context',
          note: 'consumer-share session — `user` GraphQL is agent-only; returning data from the checkToken response instead.',
          email: ctx.email,
          contact_id: ctx.contactId,
          group_id: ctx.groupId,
          saved_search_id: ctx.savedSearchId,
          agent_id: ctx.agentId,
          mls_id: ctx.mlsId,
        });
      }
    }
  );

  server.registerTool(
    'onehome_get_groups',
    {
      title: 'List my OneHome agent groups',
      description:
        'List the OneHome groups your agent has shared with you. For full agent / registered users, returns the GraphQL `user.groups` list. For magic-link consumer-share sessions (a single shared group), synthesizes a one-entry list from the `checkToken` session context.',
      annotations: {
        title: 'List my OneHome agent groups',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const data = await client.graphql<UserResponse>(buildGetOneHomeUser());
        const groups = (data.user?.groups ?? []).map(formatGroup);
        return textResult({
          source: 'graphql',
          count: groups.length,
          groups,
        });
      } catch (err) {
        if (!isAccessDenied(err)) throw err;
        const ctx = client.bridgeStatus().sessionContext;
        if (!ctx.groupId) {
          return textResult({
            source: 'session_context',
            count: 0,
            groups: [],
            note: 'consumer-share session — no groups in session context.',
          });
        }
        return textResult({
          source: 'session_context',
          count: 1,
          groups: [
            {
              group_id: ctx.groupId,
              contact_id: ctx.contactId,
              ...(ctx.email ? { emails: [ctx.email] } : {}),
              agent: ctx.agentId
                ? { id: ctx.agentId, mls_id: ctx.mlsId }
                : undefined,
            },
          ],
          note: 'derived from the checkToken response — magic-link consumer-shares see exactly one group.',
        });
      }
    }
  );

  server.registerTool(
    'onehome_get_session_context',
    {
      title: "Inspect every registered OneHome session",
      description:
        "Returns one entry per registered session — its `session_id`, auth_mode, token expiry, and session scope (group_id / saved_search_id / agent_id / contact_id / mls_id) the MCP bootstrapped from each checkToken exchange. `active_session_id` flags which session answers by default; per-listing routing prefers the session whose `mls_id` matches the listing's `~MLS` suffix. Tools default unspecified `group_id` / `saved_search_id` arguments from the active session's context, so this is the easiest way to see what they'll default to. Single-session use (the common case) returns a one-entry `sessions[]`.",
      annotations: {
        title: "Inspect every registered OneHome session",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      const sessions = client.listSessions().map((s) => ({
        session_id: s.sessionId,
        auth_mode: s.status.authMode,
        auth_ready: s.status.authReady,
        auth_expires_at: s.status.authExpiresAt,
        auth_expires_at_iso:
          s.status.authExpiresAt !== null
            ? new Date(s.status.authExpiresAt).toISOString()
            : null,
        session_context: s.status.sessionContext,
      }));
      return textResult({
        active_session_id: client.getActiveSessionId(),
        sessions,
      });
    }
  );
}

export { formatGroup };
