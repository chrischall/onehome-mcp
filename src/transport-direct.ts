/**
 * Direct Node fetch transport for onehome-mcp.
 *
 * Sources the bearer token from env (`ONEHOME_TOKEN` or
 * `ONEHOME_MAGIC_LINK`) at construction time and POSTs straight to
 * `services.onehome.com/graphql`. No browser involvement.
 *
 * `services.onehome.com` is a CoreLogic API host — it answers happily
 * to direct Node requests as long as the Authorization header is
 * present (we got a clean 401 with no bearer; see CLAUDE.md). The
 * Origin header is set to `https://portal.onehome.com` to mimic an
 * in-browser XHR, since the upstream CORS policy keys off that origin.
 *
 * Token shape detection (see `isJwtShape` in `auth.ts`): a 3-segment
 * JWT is used as-is; a single-segment base64 blob is treated as the
 * email-token and exchanged via `/api/authentication/checkToken` on
 * `start()` to obtain a real sessionToken (plus the group/savedSearch
 * scope the agent shared with this consumer).
 */

import {
  exchangeEmailToken,
  extractTokenFromMagicLink,
  isJwtShape,
  NoTokenError,
  parseJwt,
  TokenExpiredError,
} from './auth.js';
import type {
  AuthMode,
  BridgeStatus,
  GraphQLRequest,
  GraphQLResponse,
  OneHomeTransport,
  RestResponse,
  SessionContext,
} from './transport.js';

const GRAPHQL_URL = 'https://services.onehome.com/graphql';
const REST_BASE = 'https://services.onehome.com/api';
const ORIGIN = 'https://portal.onehome.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0 Safari/537.36';

export interface DirectTransportOptions {
  /**
   * Either a session-token JWT (three segments — used as bearer
   * directly) or an email-token (single-segment base64 — exchanged via
   * `/api/authentication/checkToken` on `start()`).
   */
  token: string;
  /** Which source the token came from — used only for diagnostics / healthcheck. */
  authMode: 'env_token' | 'magic_link';
  /** Fetch impl (allows tests to inject). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Build a DirectTransport by inspecting env vars. Returns null if
 * neither `ONEHOME_TOKEN` nor `ONEHOME_MAGIC_LINK` is set — caller
 * should fall back to fetchproxy mode in that case.
 *
 * `ONEHOME_TOKEN` wins when both are set; the magic-link form is a
 * convenience for users who just have the URL their agent sent them.
 */
export function tryBuildDirectTransportFromEnv(env: NodeJS.ProcessEnv): {
  transport: DirectTransport;
  authMode: 'env_token' | 'magic_link';
} | null {
  const envToken = env.ONEHOME_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return {
      transport: new DirectTransport({ token: envToken, authMode: 'env_token' }),
      authMode: 'env_token',
    };
  }
  const link = env.ONEHOME_MAGIC_LINK?.trim();
  if (link && link.length > 0) {
    const linkToken = extractTokenFromMagicLink(link);
    if (!linkToken) {
      throw new Error(
        `ONEHOME_MAGIC_LINK was set but no \`token\` query parameter was found in it. ` +
          `Expected a URL like https://portal.onehome.com/en-US/properties/map?token=eyJ...`
      );
    }
    return {
      transport: new DirectTransport({ token: linkToken, authMode: 'magic_link' }),
      authMode: 'magic_link',
    };
  }
  return null;
}

export class DirectTransport implements OneHomeTransport {
  private readonly inputToken: string;
  private readonly mode: 'env_token' | 'magic_link';
  private readonly fetchImpl: typeof fetch;
  private bearerToken: string;
  private bearerExpiresAt: number | null;
  private sessionContext: SessionContext = {};
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;
  private bootstrapped = false;

  constructor(opts: DirectTransportOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new NoTokenError();
    }
    this.inputToken = opts.token;
    this.mode = opts.authMode;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    // Optimistic init: if the input looks like a JWT we don't need
    // the exchange and we can serve `status()` immediately.
    if (isJwtShape(opts.token)) {
      this.bearerToken = opts.token;
      const parsed = parseJwt(opts.token);
      this.bearerExpiresAt = parsed?.expiresAt ?? null;
      this.bootstrapped = true;
    } else {
      this.bearerToken = '';
      this.bearerExpiresAt = null;
    }
  }

  async start(): Promise<void> {
    if (this.bootstrapped) return;
    // Email-token path: exchange for a sessionToken + session context.
    const check = await exchangeEmailToken(this.inputToken, this.fetchImpl);
    this.bearerToken = check.sessionToken;
    const parsed = parseJwt(check.sessionToken);
    this.bearerExpiresAt = parsed?.expiresAt ?? null;
    this.sessionContext = {
      ...(check.groupID ? { groupId: check.groupID } : {}),
      ...(check.savedSearchID ? { savedSearchId: check.savedSearchID } : {}),
      ...(check.agentID ? { agentId: check.agentID } : {}),
      ...(check.contactID ? { contactId: check.contactID } : {}),
      ...(check.mlsID ? { mlsId: check.mlsID } : {}),
      ...(check.email ? { email: check.email } : {}),
    };
    this.bootstrapped = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op
  async close(): Promise<void> {}

  status(): BridgeStatus {
    return {
      authMode: this.mode,
      authReady: this.bearerToken.length > 0,
      authExpiresAt: this.bearerExpiresAt,
      sessionContext: { ...this.sessionContext },
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  async graphql<T = unknown>(req: GraphQLRequest): Promise<GraphQLResponse<T>> {
    if (!this.bootstrapped) await this.start();
    if (this.bearerExpiresAt !== null && this.bearerExpiresAt < Date.now()) {
      throw new TokenExpiredError(this.bearerExpiresAt);
    }
    const body = JSON.stringify({
      operationName: req.operationName,
      query: req.query,
      variables: req.variables ?? {},
    });
    let response: Response;
    try {
      response = await this.fetchImpl(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.bearerToken}`,
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
          'User-Agent': USER_AGENT,
        },
        body,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(`network error: ${msg}`);
      throw new Error(`onehome-mcp direct fetch failed: ${msg}`);
    }
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      this.recordFailure(`HTTP ${response.status}`);
      throw new Error(
        `OneHome GraphQL rejected the token (HTTP ${response.status}). ` +
          `Authorization header is invalid or expired. Refresh ONEHOME_TOKEN / ONEHOME_MAGIC_LINK.`
      );
    }
    let parsed: { data?: T; errors?: GraphQLResponse<T>['errors'] };
    try {
      parsed = JSON.parse(text);
    } catch {
      this.recordFailure(`non-JSON response (HTTP ${response.status})`);
      throw new Error(
        `OneHome GraphQL returned non-JSON (HTTP ${response.status}): ` +
          `${text.slice(0, 200)}`
      );
    }
    if (response.status >= 200 && response.status < 300) {
      this.recordSuccess();
    } else {
      this.recordFailure(`HTTP ${response.status}`);
    }
    return {
      data: parsed.data,
      errors: parsed.errors,
      status: response.status,
      url: response.url || GRAPHQL_URL,
    };
  }

  async rest<T = unknown>(path: string): Promise<RestResponse<T>> {
    if (!this.bootstrapped) await this.start();
    if (this.bearerExpiresAt !== null && this.bearerExpiresAt < Date.now()) {
      throw new TokenExpiredError(this.bearerExpiresAt);
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = `${REST_BASE}${normalized}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.bearerToken}`,
          Origin: ORIGIN,
          Referer: `${ORIGIN}/`,
          'User-Agent': USER_AGENT,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(`rest network error: ${msg}`);
      throw new Error(`onehome-mcp REST fetch failed: ${msg}`);
    }
    const text = await response.text();
    const isOk = response.status >= 200 && response.status < 300;
    if (isOk) this.recordSuccess();
    else this.recordFailure(`REST HTTP ${response.status}`);
    let data: T | string = text;
    if (isOk) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // Leave data as raw text if JSON parse fails.
      }
    }
    return {
      status: response.status,
      url: response.url || url,
      data,
      ok: isOk && typeof data !== 'string',
    };
  }

  /** Test seam — let unit tests inject a known timestamp. */
  _recordForTest(kind: 'success' | 'failure', reason?: string): void {
    if (kind === 'success') this.recordSuccess();
    else this.recordFailure(reason ?? 'test');
  }

  private recordSuccess(): void {
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(reason: string): void {
    this.lastFailureAt = Date.now();
    this.lastFailureReason = reason;
    this.consecutiveFailures += 1;
  }
}

export type DirectAuthMode = Extract<AuthMode, 'env_token' | 'magic_link'>;
