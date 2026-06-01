/**
 * fetchproxy transport for onehome-mcp.
 *
 * Used when neither `ONEHOME_TOKEN` nor `ONEHOME_MAGIC_LINK` is set.
 * The user is expected to have the fetchproxy browser extension
 * installed and a signed-in `portal.onehome.com` tab open.
 *
 * The first time we need a token we ask fetchproxy to snapshot the
 * Authorization header on the next outbound GraphQL request the user
 * makes from that tab — any UI interaction (scrolling the map,
 * clicking a result, etc.) triggers one. We then cache the captured
 * value and use it for all subsequent direct `services.onehome.com`
 * fetches.
 *
 * This is a "Pattern B" bootstrap: one in-tab capture, then direct
 * outbound from Node. We don't re-route every GraphQL call through
 * the tab because the GraphQL endpoint is happy to take direct
 * connections once the Authorization is correct, and round-tripping
 * every call through fetchproxy adds latency + a bridge-down failure
 * mode for no benefit.
 */

import {
  FetchproxyServer,
  FetchproxyBridgeDownError,
  type FetchproxyServerOpts,
} from '@chrischall/mcp-utils/fetchproxy';
import { parseJwt, TokenExpiredError } from './auth.js';
import type {
  BridgeStatus,
  GraphQLRequest,
  GraphQLResponse,
  OneHomeTransport,
  RestResponse,
} from './transport.js';

// 0.8.0+: re-export the server's typed bridge-down error so callers
// who previously caught onehome-mcp's local class keep working with
// no import-path change.
export { FetchproxyBridgeDownError } from '@chrischall/mcp-utils/fetchproxy';

const DEFAULT_PORT = 37_149;
const GRAPHQL_URL = 'https://services.onehome.com/graphql';
const REST_BASE = 'https://services.onehome.com/api';
const GRAPHQL_URL_PATTERN = 'https://services.onehome.com/graphql*';
const ORIGIN = 'https://portal.onehome.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0 Safari/537.36';
const CAPTURE_TIMEOUT_MS = 120_000;

/**
 * Thrown when captureRequestHeader() returns a non-bridge-down error —
 * typically the 120s user-interaction timeout (the user hasn't moved
 * the map / clicked a pin / etc. yet so no GraphQL call has gone out
 * for us to snapshot).
 *
 * Service-worker eviction is NOT this error: as of @fetchproxy/server
 * 0.8.0 the server detects content_script_unreachable, waits
 * `bridgeReviveDelayMs` (default 2000), retries once, and throws
 * `FetchproxyBridgeDownError` if the SW is still gone. Those errors
 * pass through this adapter untouched. The 120s window here is purely
 * UX-grade "the user hasn't interacted yet"; it doesn't have to absorb
 * SW evictions any more.
 */
export class FetchproxyAuthCaptureError extends Error {
  constructor(originalError: string) {
    super(
      `onehome-mcp could not capture an Authorization header from your ` +
        `signed-in portal.onehome.com tab within ${CAPTURE_TIMEOUT_MS / 1000}s. ` +
        `Make sure: (a) the fetchproxy browser extension is installed and ` +
        `paired, (b) you have portal.onehome.com open and signed in, and ` +
        `(c) you've interacted with the page (scrolled the map, clicked a ` +
        `pin, etc.) to trigger a GraphQL call. ` +
        `(Service-worker eviction is handled separately by ` +
        `@fetchproxy/server 0.8.0 and surfaces as FetchproxyBridgeDownError, ` +
        `not this error.) Underlying error: ` +
        originalError
    );
    this.name = 'FetchproxyAuthCaptureError';
  }
}

export interface FetchproxyTransportOptions {
  port?: number;
  version: string;
  fetchImpl?: typeof fetch;
  /** Test seam: skip listen() / capture, supply a pre-baked token. */
  _testToken?: string;
}

export class FetchproxyTransport implements OneHomeTransport {
  private readonly bridge: FetchproxyServer;
  private readonly port: number;
  private readonly serverVersion: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;
  private tokenExpiresAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private lastFailureReason: string | null = null;
  private consecutiveFailures = 0;
  private capturePromise: Promise<string> | null = null;

  constructor(opts: FetchproxyTransportOptions) {
    this.port = opts.port ?? DEFAULT_PORT;
    this.serverVersion = opts.version;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    const config: FetchproxyServerOpts = {
      port: this.port,
      serverName: 'onehome-mcp',
      version: opts.version,
      domains: ['onehome.com'],
      // We only capture the Authorization header from the user's
      // signed-in portal.onehome.com tab — we don't proxy fetches
      // through the bridge. The default capability set is ['fetch'],
      // which does NOT include 'capture_request_header', so the bridge
      // would reject captureRequestHeader() with a "did not declare"
      // error. Declare explicitly.
      capabilities: ['capture_request_header'],
      captureHeaders: [
        {
          urlPattern: GRAPHQL_URL_PATTERN,
          headerName: 'Authorization',
        },
      ],
      // 0.8.0+ server handles SW-eviction lazy-revive internally
      // (default 2000ms) and throws FetchproxyBridgeDownError on
      // persistent failure.
      // keepAliveIntervalMs is no longer set here: @fetchproxy/server 0.10.0
      // defaults it to 25_000 — exactly the cadence we relied on for the
      // capture-mode token-refresh window (fetchproxy#72).
    };
    this.bridge = new FetchproxyServer(config);
    if (opts._testToken) this.setToken(opts._testToken);
  }

  async start(): Promise<void> {
    if (this.token) return;
    await this.bridge.listen();
    console.error(
      `[onehome-mcp:bridge] listening on 127.0.0.1:${this.port} ` +
        `(role=${this.bridge.role ?? 'unknown'}, version=${this.serverVersion}). ` +
        `Waiting for the first portal.onehome.com GraphQL request to capture the Authorization header.`
    );
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }

  status(): BridgeStatus {
    // 0.8.0+: the server tracks "is the extension still answering?"
    // liveness for us via bridgeHealth().lastExtensionMessageAt — pass
    // it through so consumers (healthcheck tool, session-context tool)
    // can show extension liveness independently of the last capture or
    // last GraphQL call.
    const health = this.bridge.bridgeHealth();
    return {
      authMode: 'fetchproxy_capture',
      authReady: this.token !== null,
      authExpiresAt: this.tokenExpiresAt,
      // Capture mode sees only the Authorization header — there's no
      // checkToken response we can extract group/savedSearch scope
      // from. Tools that default `group_id` from `sessionContext` will
      // simply require explicit args under this transport.
      sessionContext: {},
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureReason: this.lastFailureReason,
      consecutiveFailures: this.consecutiveFailures,
      fetchproxy: {
        role: this.bridge.role,
        port: this.port,
        serverVersion: this.serverVersion,
        lastExtensionMessageAt: health.lastExtensionMessageAt,
      },
    };
  }

  /**
   * Ensure a *non-expired* captured token is in hand before an outbound
   * call. If the captured token expired mid-session, drop it and
   * recapture; if the recapture still yields an expired token, raise
   * `TokenExpiredError`. Shared by graphql() and rest() so both paths
   * never fire a request with a known-dead bearer.
   */
  private async ensureFreshToken(): Promise<void> {
    await this.ensureToken();
    if (this.tokenExpiresAt !== null && this.tokenExpiresAt < Date.now()) {
      // Captured token expired mid-session — drop it and recapture.
      this.dropToken();
      try {
        await this.ensureToken();
      } catch (err) {
        if (this.tokenExpiresAt !== null && this.tokenExpiresAt < Date.now()) {
          throw new TokenExpiredError(this.tokenExpiresAt);
        }
        throw err;
      }
    }
  }

  /** Discard the captured token so the next ensureToken() recaptures. */
  private dropToken(): void {
    this.token = null;
    this.tokenExpiresAt = null;
    this.capturePromise = null;
  }

  async graphql<T = unknown>(req: GraphQLRequest): Promise<GraphQLResponse<T>> {
    await this.ensureFreshToken();
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
          Authorization: `Bearer ${this.token}`,
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
      // Captured token has been revoked — discard and try once more.
      this.dropToken();
      this.recordFailure(`HTTP ${response.status}`);
      throw new Error(
        `OneHome GraphQL rejected the captured token (HTTP ${response.status}). ` +
          `Trigger a fresh GraphQL call from your portal.onehome.com tab and retry.`
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
    const normalized = path.startsWith('/') ? path : `/${path}`;
    const url = `${REST_BASE}${normalized}`;
    // 401/403 means the captured bearer was revoked. Mirror graphql()'s
    // recapture intent on this path too: drop the dead token, recapture,
    // and retry the request once so a stale capture self-heals. A
    // *persistent* 401/403 (e.g. the agent-only LocalLogic schools
    // dataset, which a fresh token still can't reach) falls through and
    // the non-ok response is returned — the schools tool surfaces that
    // cleanly rather than throwing. The token-expiry-drop in
    // ensureFreshToken() runs before each attempt so we never fire with a
    // known-dead bearer.
    let status = 0;
    let responseUrl = url;
    let text = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureFreshToken();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
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
      // Read the body exactly once per response.
      text = await response.text();
      status = response.status;
      responseUrl = response.url || url;
      if ((status === 401 || status === 403) && attempt === 0) {
        // Revoked-token surface — drop it and retry once with a fresh
        // capture. A persistent 401/403 (agent-only dataset) survives the
        // retry and falls through to the non-ok response below.
        this.dropToken();
        this.recordFailure(`REST HTTP ${status}`);
        continue;
      }
      break;
    }
    const isOk = status >= 200 && status < 300;
    if (isOk) this.recordSuccess();
    else this.recordFailure(`REST HTTP ${status}`);
    let data: T | string = text;
    if (isOk) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // leave as text
      }
    }
    return {
      status,
      url: responseUrl,
      data,
      ok: isOk && typeof data !== 'string',
    };
  }

  private async ensureToken(): Promise<void> {
    if (this.token) return;
    if (!this.capturePromise) {
      this.capturePromise = this.captureToken();
    }
    const captured = await this.capturePromise;
    this.setToken(captured);
  }

  private async captureToken(): Promise<string> {
    let raw: string;
    try {
      // 0.8.0+: no args needed — we have a single declared captureHeaders
      // entry and the server defaults to it.
      raw = await this.bridge.captureRequestHeader({
        timeoutMs: CAPTURE_TIMEOUT_MS,
      });
    } catch (err) {
      // The server now throws FetchproxyBridgeDownError directly on
      // SW eviction (with its own lazy-revive retry handled). Pass
      // those through untouched; wrap everything else as a
      // capture-mode error with onehome-specific guidance.
      if (err instanceof FetchproxyBridgeDownError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new FetchproxyAuthCaptureError(msg);
    }
    // `Authorization: Bearer eyJ...` — strip the prefix if present.
    const trimmed = raw.trim();
    if (/^Bearer\s+/i.test(trimmed)) {
      return trimmed.replace(/^Bearer\s+/i, '');
    }
    return trimmed;
  }

  private setToken(token: string): void {
    this.token = token;
    const parsed = parseJwt(token);
    this.tokenExpiresAt = parsed?.expiresAt ?? null;
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
