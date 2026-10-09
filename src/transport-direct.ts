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

import { detectEdgeBlock, EdgeBlockedError, readEnvVar } from '@chrischall/mcp-utils';
import {
  decodeJwtExpiresAtMs,
  exchangeEmailToken,
  extractTokenFromMagicLink,
  isJwtShape,
  NoTokenError,
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
import {
  fetchTextWithDeadline,
  OneHomeRequestTimeoutError,
} from './request-deadline.js';

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
  /** Per-request deadline in ms (fetch + body read). Defaults to `REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
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
  // readEnvVar treats empty values and unsubstituted .mcpb
  // `${user_config.*}` placeholders as unset (fleet-audit#618).
  const envToken = readEnvVar('ONEHOME_TOKEN', { env });
  if (envToken) {
    return {
      transport: new DirectTransport({ token: envToken, authMode: 'env_token' }),
      authMode: 'env_token',
    };
  }
  const link = readEnvVar('ONEHOME_MAGIC_LINK', { env });
  if (link) {
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
  private readonly requestTimeoutMs: number | undefined;
  private bearerToken: string;
  private bearerExpiresAt: number | null;
  private sessionContext: SessionContext = {};
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;
  private bootstrapped = false;
  /** In-flight first exchange, shared by concurrent callers; cleared on rejection. */
  private startPromise: Promise<void> | null = null;
  /** In-flight expiry re-exchange, shared by concurrent callers. */
  private refreshPromise: Promise<void> | null = null;

  constructor(opts: DirectTransportOptions) {
    if (!opts.token || opts.token.length === 0) {
      throw new NoTokenError();
    }
    this.inputToken = opts.token;
    this.mode = opts.authMode;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs;
    // Optimistic init: if the input looks like a JWT we don't need
    // the exchange and we can serve `status()` immediately.
    if (isJwtShape(opts.token)) {
      this.bearerToken = opts.token;
      this.bearerExpiresAt = decodeJwtExpiresAtMs(opts.token);
      this.bootstrapped = true;
    } else {
      this.bearerToken = '';
      this.bearerExpiresAt = null;
    }
  }

  async start(): Promise<void> {
    if (this.bootstrapped) return;
    // Memoize the in-flight exchange so a concurrent fan-out (bulk_get's
    // 6 workers) fires one checkToken, not six. Cleared on rejection so
    // the next call retries (fleet-audit#617).
    if (!this.startPromise) {
      this.startPromise = this.exchange().catch((err: unknown) => {
        this.startPromise = null;
        throw err;
      });
    }
    return this.startPromise;
  }

  /** Email-token path: exchange for a sessionToken + session context. */
  private async exchange(): Promise<void> {
    const check = await exchangeEmailToken(this.inputToken, this.fetchImpl);
    this.bearerToken = check.sessionToken;
    this.bearerExpiresAt = decodeJwtExpiresAtMs(check.sessionToken);
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

  /**
   * Bootstrap if needed, then make sure the bearer isn't past its `exp`.
   * A JWT pasted directly can't be refreshed, so it throws
   * `TokenExpiredError`. An email-token (magic link) is longer-lived than
   * the session JWT it was exchanged for — the portal itself re-exchanges
   * it on load — so re-run checkToken once (shared between concurrent
   * callers) and only throw if that fails or still yields an expired
   * token (fleet-audit#617).
   */
  private async ensureFreshBearer(): Promise<void> {
    if (!this.bootstrapped) await this.start();
    const expired = (): boolean =>
      this.bearerExpiresAt !== null && this.bearerExpiresAt < Date.now();
    if (!expired()) return;
    const expiredAt = this.bearerExpiresAt as number;
    if (isJwtShape(this.inputToken)) throw new TokenExpiredError(expiredAt);
    if (!this.refreshPromise) {
      this.refreshPromise = this.exchange().finally(() => {
        this.refreshPromise = null;
      });
    }
    try {
      await this.refreshPromise;
    } catch {
      throw new TokenExpiredError(expiredAt);
    }
    if (expired()) throw new TokenExpiredError(this.bearerExpiresAt as number);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- no-op
  async close(): Promise<void> {}

  /**
   * The active bearer token. Intentionally returned by reference so
   * `OneHomeClient.setAuthFromInput` can fingerprint it for the
   * `onehome_set_auth` response without re-exposing it via
   * `BridgeStatus`. Callers must not leak this value to network
   * responses or logs — it is the credential.
   */
  currentBearer(): string {
    return this.bearerToken;
  }

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
    await this.ensureFreshBearer();
    const body = JSON.stringify({
      operationName: req.operationName,
      query: req.query,
      variables: req.variables ?? {},
    });
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await fetchTextWithDeadline(
        this.fetchImpl,
        GRAPHQL_URL,
        {
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
        },
        {
          label: `OneHome GraphQL ${req.operationName}`,
          timeoutMs: this.requestTimeoutMs,
        }
      ));
    } catch (err) {
      if (err instanceof OneHomeRequestTimeoutError) {
        this.recordFailure(err.message);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(`network error: ${msg}`);
      throw new Error(`onehome-mcp direct fetch failed: ${msg}`);
    }
    // A CDN/WAF refusal page arrives as a 403 too, but the API never saw the
    // token — so not "rejected the token" (chrischall/mcp-host#1015).
    const edge = detectEdgeBlock({ body: text, headers: response.headers, status: response.status });
    if (edge !== null) {
      this.recordFailure(`HTTP ${response.status} (blocked at ${edge.vendor})`);
      throw new EdgeBlockedError(response.status, edge.vendor, {
        service: 'OneHome GraphQL',
        method: 'POST',
        path: `/graphql (${req.operationName})`,
      });
    }
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
    await this.ensureFreshBearer();
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = `${REST_BASE}${normalized}`;
    let response: Response;
    let text: string;
    try {
      ({ response, text } = await fetchTextWithDeadline(
        this.fetchImpl,
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.bearerToken}`,
            Origin: ORIGIN,
            Referer: `${ORIGIN}/`,
            'User-Agent': USER_AGENT,
          },
        },
        { label: `OneHome REST ${normalized}`, timeoutMs: this.requestTimeoutMs }
      ));
    } catch (err) {
      if (err instanceof OneHomeRequestTimeoutError) {
        this.recordFailure(err.message);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFailure(`rest network error: ${msg}`);
      throw new Error(`onehome-mcp REST fetch failed: ${msg}`);
    }
    // Thrown, as graphql() throws: returned as a non-ok RestResponse, a block
    // reaches the schools/walk-score tools as "this dataset is agent-only"
    // (chrischall/mcp-host#1015, onehome#226).
    const edge = detectEdgeBlock({ body: text, headers: response.headers, status: response.status });
    if (edge !== null) {
      this.recordFailure(`REST HTTP ${response.status} (blocked at ${edge.vendor})`);
      throw new EdgeBlockedError(response.status, edge.vendor, {
        service: 'OneHome REST',
        method: 'GET',
        path: normalized,
      });
    }
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
