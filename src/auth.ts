/**
 * Token-handling helpers shared by both transports.
 *
 * OneHome uses bearer-token auth (`Authorization: Bearer <jwt>`)
 * against `services.onehome.com/graphql`. We accept the token from
 * three different sources at startup:
 *
 *   1. `ONEHOME_TOKEN` — raw JWT pasted from the user's devtools.
 *   2. `ONEHOME_MAGIC_LINK` — full URL with `?token=...`; we extract
 *      the `token` query param and use it directly (the portal app's
 *      bundle confirms: `let Ve = ze.queryParams.token || ...`).
 *   3. fetchproxy `captureRequestHeader` — wait for the user's signed-
 *      in portal.onehome.com tab to fire any GraphQL request, snapshot
 *      its Authorization header, and reuse the captured value.
 *
 * Source #3 lives entirely in `transport-fetchproxy.ts`. This module
 * is just the parsing + JWT-introspection helpers.
 */

import { withDeadline } from '@chrischall/mcp-utils/fetchproxy';
import {
  decodeJwtClaim,
  McpToolError,
  truncateErrorMessage,
} from '@chrischall/mcp-utils';

/**
 * Decode a JWT's `exp` claim into a unix-ms timestamp. Does NOT verify
 * the signature — we never had the signing key to start with, the
 * upstream server does that. This is purely for "is this token about
 * to expire" diagnostics.
 *
 * Thin unit-conversion wrapper over mcp-utils' `decodeJwtClaim` (which
 * owns the base64url payload decode): standard JWT `exp` is
 * unix-seconds, while the transports track absolute expiry in unix-ms.
 * Returns null for an undecodable token or an absent/non-numeric `exp`.
 */
export function decodeJwtExpiresAtMs(token: string): number | null {
  const exp = decodeJwtClaim(token, 'exp');
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
}

/**
 * Pull the `token` query param out of a magic-link URL. Accepts any
 * URL shape (with or without scheme) and returns the param value, or
 * null if it isn't present.
 *
 * OneHome's magic links look like
 *   https://portal.onehome.com/en-US/properties/map?token=eyJ...
 * (or any other path on portal.onehome.com).
 */
export function extractTokenFromMagicLink(link: string): string | null {
  // Normalize so the URL parser is happy even with input like
  // "portal.onehome.com/...?token=...".
  let candidate = link.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  const value = u.searchParams.get('token');
  return value && value.length > 0 ? value : null;
}

export class TokenExpiredError extends McpToolError {
  readonly expiredAt: number;
  constructor(expiredAt: number) {
    const ageSec = Math.round((Date.now() - expiredAt) / 1000);
    const refreshHint =
      `Refresh it: open portal.onehome.com (signed-in), grab a new bearer from ` +
      `devtools Network tab, and update ONEHOME_TOKEN — or paste a fresh magic-link ` +
      `URL into ONEHOME_MAGIC_LINK — or call the \`onehome_set_auth\` tool with the ` +
      `new link / bearer to refresh in-session without a restart.`;
    super(
      `OneHome bearer token expired ${ageSec}s ago at ${new Date(expiredAt).toISOString()}. ` +
        refreshHint,
      { hint: refreshHint }
    );
    this.name = 'TokenExpiredError';
    this.expiredAt = expiredAt;
  }
}

export class NoTokenError extends Error {
  constructor() {
    super(
      'onehome-mcp could not source an Authorization bearer token. ' +
        'Set ONEHOME_TOKEN (raw JWT), or ONEHOME_MAGIC_LINK (portal URL with ?token=...), ' +
        'or run with the fetchproxy browser extension connected to a signed-in portal.onehome.com tab. ' +
        'You can also set the bearer at runtime via the `onehome_set_auth` tool — pass the magic-link URL or the JWT directly.'
    );
    this.name = 'NoTokenError';
  }
}

/**
 * Parse a free-form auth input — a magic-link URL, a raw JWT bearer,
 * or an email-token — into the canonical `{ token, source }` shape
 * that `DirectTransport` accepts. Used by the runtime
 * `onehome_set_auth` tool (and could be re-used at startup for
 * symmetry with `tryBuildDirectTransportFromEnv`).
 *
 * Detection order:
 *   1. Looks like a URL (has a scheme or `?token=`) → magic-link;
 *      extract the `token` query param, treat as email-token.
 *   2. Looks like a 3-segment JWT → use directly as bearer.
 *   3. Anything else → assume it's a single-segment email-token;
 *      the DirectTransport will exchange it via checkToken.
 */
export interface ParsedAuthInput {
  /** The token to hand to DirectTransport — either a JWT or an email-token. */
  token: string;
  /** How the input was sourced — for status reporting + telemetry. */
  source: 'magic_link' | 'env_token';
}

export function parseAuthInput(input: string): ParsedAuthInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new NoTokenError();
  }
  // URL form: extract the ?token= param.
  if (/^https?:\/\//i.test(trimmed) || /[?&]token=/.test(trimmed)) {
    const linkToken = extractTokenFromMagicLink(trimmed);
    if (!linkToken) {
      throw new Error(
        `onehome_set_auth: input looks like a URL but has no \`token\` query parameter. ` +
          `Expected a magic link like https://portal.onehome.com/en-US/properties/map?token=eyJ...`
      );
    }
    return { token: linkToken, source: 'magic_link' };
  }
  // Otherwise treat as a raw token. DirectTransport handles both
  // 3-segment-JWT (use directly) and 1-segment email-token (exchange).
  return { token: trimmed, source: 'env_token' };
}

/**
 * True if `token` looks like a standard JWT (three base64url segments).
 *
 * OneHome's portal URL `?token=...` carries a single-segment base64
 * blob (the email-token: a JSON descriptor of the consumer share —
 * `{ OSN, type, contactid, setid, setkey, email, ..., agentid }`).
 * That blob is NOT a bearer — the SPA exchanges it for a real JWT
 * sessionToken via `/api/authentication/checkToken` before using it.
 *
 * The exchanged sessionToken IS a standard JWT (with `exp` etc.).
 *
 * `ONEHOME_TOKEN` can be either:
 *   - A pre-exchanged sessionToken (paste from devtools Network panel):
 *     three segments → use directly as bearer.
 *   - The raw email-token from the URL: one segment → needs the
 *     checkToken exchange first.
 *
 * `ONEHOME_MAGIC_LINK` always carries the email-token form, since
 * that's what agents email — always exchange.
 *
 * This is deliberately a shape-only probe (no payload decode): the
 * caller routes 3-segment tokens straight to the bearer path and
 * 1-segment blobs to the checkToken exchange. Expiry introspection on
 * the JWT path goes through mcp-utils (`decodeJwtExpiresAtMs` above).
 */
export function isJwtShape(token: string): boolean {
  return /^[^.]+\.[^.]+\.[^.]+$/.test(token);
}

export interface CheckTokenResponse {
  sessionToken: string;
  groupID?: string;
  savedSearchID?: string;
  agentID?: string;
  contactID?: string;
  mlsID?: string;
  email?: string;
  signedIn?: boolean;
  registered?: boolean;
  rumToken?: string;
  /** Captured raw response for caller diagnostics / unexpected fields. */
  raw: Record<string, unknown>;
}

const CHECK_TOKEN_URL =
  'https://services.onehome.com/api/authentication/checkToken';
const ORIGIN = 'https://portal.onehome.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export class CheckTokenError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(
      `OneHome /api/authentication/checkToken rejected the email token ` +
        `(HTTP ${status}). The token may be expired or malformed — ask your ` +
        `real-estate agent to resend the magic link. Upstream body: ` +
        truncateErrorMessage(body, 200)
    );
    this.name = 'CheckTokenError';
    this.status = status;
  }
}

/**
 * Distinct from `CheckTokenError` (issue #55): the checkToken *exchange
 * itself* did not complete within the per-attempt deadline. A stale or
 * invalid magic-link token can make upstream accept the connection but
 * never (or very slowly) respond; without a deadline the `await fetch`
 * wedges for the full MCP client timeout (~4 min) and the user sees a
 * multi-minute hang instead of an actionable error.
 *
 * This is a *transport timeout*, classified separately from a token
 * rejection (HTTP 4xx → `CheckTokenError`) so callers and tests can tell
 * "the network/upstream stalled" apart from "the token is bad".
 */
export class CheckTokenTimeoutError extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(
      `OneHome /api/authentication/checkToken timed out after ${deadlineMs}ms. ` +
        `The token exchange did not complete in time — this is usually a stale ` +
        `magic-link token (upstream accepts the connection but never responds) ` +
        `or a transient network/upstream stall. Try a fresh magic-link URL via ` +
        `the \`onehome_set_auth\` tool, or retry if connectivity was the issue. ` +
        `(Failing fast here instead of hanging for the full client timeout.)`
    );
    this.name = 'CheckTokenTimeoutError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Default per-attempt deadline for the checkToken exchange. Set well below
 * the MCP SDK request deadline (60s default tool timeout / multi-minute
 * client timeout) so a wedged exchange fails fast with
 * `CheckTokenTimeoutError` rather than hanging the whole `onehome_set_auth`
 * call. (Issue #55.)
 */
export const CHECK_TOKEN_DEADLINE_MS = 20_000;

export interface ExchangeEmailTokenOptions {
  /** Per-attempt deadline in ms. Defaults to `CHECK_TOKEN_DEADLINE_MS`. */
  deadlineMs?: number;
}

/**
 * Exchange an email-token (the `?token=` value from a OneHome magic
 * link) for a session-token bearer + session context (groupID,
 * savedSearchID, agentID, …) by POSTing to
 * `/api/authentication/checkToken`. This is the bootstrap step the
 * Angular portal does on app load:
 *
 *   POST /api/authentication/checkToken
 *   { "emailToken": "<URL ?token= value>" }
 *
 * The response carries the bearer (`sessionToken`) plus the consumer's
 * scope (which group / saved search the agent shared with them).
 */
export async function exchangeEmailToken(
  emailToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
  options: ExchangeEmailTokenOptions = {}
): Promise<CheckTokenResponse> {
  const deadlineMs = options.deadlineMs ?? CHECK_TOKEN_DEADLINE_MS;
  // Race the whole network round-trip (fetch + body read) against a
  // per-attempt deadline (issue #55). A stale token can make upstream
  // accept the connection but never respond; without this the await would
  // hang for the full MCP client timeout (~4 min). On deadline expiry we
  // throw `CheckTokenTimeoutError` — a transport timeout, classified
  // distinctly from a token rejection (HTTP 4xx → `CheckTokenError`).
  const roundTrip = (async (): Promise<{ status: number; text: string }> => {
    const response = await fetchImpl(CHECK_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ emailToken }),
    });
    return { status: response.status, text: await response.text() };
  })();

  const outcome = await withDeadline(roundTrip, deadlineMs);
  if (outcome.timedOut) {
    throw new CheckTokenTimeoutError(deadlineMs);
  }
  const { status, text } = outcome.value;
  if (status < 200 || status >= 300) {
    throw new CheckTokenError(status, text);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CheckTokenError(status, `non-JSON: ${text}`);
  }
  const sessionToken = parsed.sessionToken;
  if (typeof sessionToken !== 'string' || sessionToken.length === 0) {
    throw new CheckTokenError(status, `response missing sessionToken: ${text}`);
  }
  const pickString = (k: string): string | undefined =>
    typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined;
  return {
    sessionToken,
    groupID: pickString('groupID'),
    savedSearchID: pickString('savedSearchID'),
    agentID: pickString('agentID'),
    contactID: pickString('contactID'),
    mlsID: pickString('mlsID'),
    email: pickString('email'),
    signedIn:
      typeof parsed.signedIn === 'boolean' ? parsed.signedIn : undefined,
    registered:
      typeof parsed.registered === 'boolean'
        ? parsed.registered
        : undefined,
    rumToken: pickString('rumToken'),
    raw: parsed,
  };
}
