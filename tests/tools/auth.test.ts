import { describe, it, expect, afterEach, vi } from 'vitest';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';
import { OneHomeClient } from '../../src/client.js';
import { registerAuthTools } from '../../src/tools/auth.js';

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.signature`;
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

interface SetAuthResult {
  session_id: string;
  active_session_id: string;
  auth_mode: string;
  auth_ready: boolean;
  auth_expires_at: number | null;
  session_context: Record<string, string | undefined>;
  bearer_fingerprint: string;
}

async function setAuthAndGet(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<{ result: SetAuthResult; client: OneHomeClient; fetchMock: ReturnType<typeof vi.fn> }> {
  const client = new OneHomeClient({ transport });
  const fetchMock = vi.fn();
  client._setFetchImplForTest(fetchMock as unknown as typeof fetch);
  harness = await createTestHarness((server) => registerAuthTools(server, client));
  const result = await harness.callTool('onehome_set_auth', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text');
  return { result: JSON.parse(first.text) as SetAuthResult, client, fetchMock };
}

describe('onehome_set_auth', () => {
  it('accepts a 3-segment JWT directly (no checkToken exchange)', async () => {
    const jwt = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const closeSpy = vi.spyOn(transport, 'close');
    const { result, fetchMock } = await setAuthAndGet(transport, { input: jwt });
    expect(result.auth_mode).toBe('env_token');
    expect(result.auth_ready).toBe(true);
    expect(result.auth_expires_at).toBe(9_999_999_999_000);
    expect(fetchMock).not.toHaveBeenCalled(); // No exchange needed for a JWT.
    // Multi-session: old transport is NOT closed — it stays registered
    // so the caller can switch back via `onehome_set_active_session`
    // or rely on MLS-suffix routing.
    expect(closeSpy).not.toHaveBeenCalled();
    expect(result.session_id).toMatch(/^session-\d+$/);
    expect(result.active_session_id).toBe(result.session_id);
  });

  it('exchanges a magic-link URL and populates session_context', async () => {
    const sessionJwt = makeJwt({ sub: 'session', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({
          sessionToken: sessionJwt,
          groupID: 'G-LAKELURE',
          savedSearchID: 'SS-NC',
          email: 'buyer@example.com',
        }),
    });
    client._setFetchImplForTest(fetchMock as unknown as typeof fetch);
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const r = await harness.callTool('onehome_set_auth', {
      input: 'https://portal.onehome.com/en-US/properties/map?token=email-token-xyz',
    });
    const parsed = JSON.parse(
      (r.content[0] as { text: string }).text
    ) as SetAuthResult;
    expect(parsed.auth_mode).toBe('magic_link');
    expect(parsed.auth_ready).toBe(true);
    expect(parsed.session_context.groupId).toBe('G-LAKELURE');
    expect(parsed.session_context.savedSearchId).toBe('SS-NC');
    expect(parsed.session_context.email).toBe('buyer@example.com');
    // The post body should have been the email-token, not the URL.
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as { body: string }).body
    );
    expect(body.emailToken).toBe('email-token-xyz');
  });

  it('returns a token fingerprint of the bearer, never the full input', async () => {
    const jwt = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const { result } = await setAuthAndGet(transport, { input: jwt });
    expect(result.bearer_fingerprint).toMatch(/…/);
    expect(result.bearer_fingerprint.length).toBeLessThan(jwt.length);
    // Sanity: fingerprint should not contain the JWT signature in full.
    expect(result.bearer_fingerprint).not.toContain(jwt.slice(20, 60));
  });

  it('fingerprints the resolved bearer for magic-link input (not the URL)', async () => {
    // For magic-link input the raw `input` is a URL — fingerprinting
    // it would surface "https://p…link" which tells the user nothing
    // about the credential. Verify the fingerprint reflects the
    // exchanged sessionToken instead.
    const sessionJwt = makeJwt({ sub: 'session', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () =>
        JSON.stringify({ sessionToken: sessionJwt, email: 'b@x.com' }),
    });
    client._setFetchImplForTest(fetchMock as unknown as typeof fetch);
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const url = 'https://portal.onehome.com/en-US/properties/map?token=email-token-xyz';
    const r = await harness.callTool('onehome_set_auth', { input: url });
    const parsed = JSON.parse(
      (r.content[0] as { text: string }).text
    ) as SetAuthResult;
    // Fingerprint should start with the JWT's first 8 chars, not the URL's.
    expect(parsed.bearer_fingerprint).toMatch(/^[A-Za-z0-9_-]+…[A-Za-z0-9_-]+$/);
    expect(parsed.bearer_fingerprint.startsWith(sessionJwt.slice(0, 8))).toBe(true);
    expect(parsed.bearer_fingerprint.startsWith('https://')).toBe(false);
  });

  it('subsequent calls through the client use the new transport (the swap took)', async () => {
    const jwt = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const closeSpy = vi.spyOn(transport, 'close');
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    await harness.callTool('onehome_set_auth', { input: jwt });
    // Multi-session: old transport stays registered (no close).
    expect(closeSpy).not.toHaveBeenCalled();
    // After additive registration, the new DirectTransport is active
    // and reports `authMode: 'env_token'` with the JWT bearer.
    const status = client.bridgeStatus();
    expect(status.authMode).toBe('env_token');
    expect(status.authReady).toBe(true);
    // Two sessions now registered.
    expect(client.listSessions()).toHaveLength(2);
  });

  it('registers additional sessions without replacing the active one (additive)', async () => {
    const jwt1 = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const jwt2 = makeJwt({ sub: 'u2', exp: 9_999_999_998 });
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );

    const r1 = await harness.callTool('onehome_set_auth', { input: jwt1 });
    const r2 = await harness.callTool('onehome_set_auth', { input: jwt2 });
    const p1 = JSON.parse((r1.content[0] as { text: string }).text) as SetAuthResult;
    const p2 = JSON.parse((r2.content[0] as { text: string }).text) as SetAuthResult;
    expect(p1.session_id).not.toBe(p2.session_id);
    // Three sessions: initial FakeTransport + 2 from set_auth.
    expect(client.listSessions()).toHaveLength(3);
    // Latest set_auth call wins for active.
    expect(client.getActiveSessionId()).toBe(p2.session_id);
  });
});

describe('onehome_set_active_session', () => {
  it('switches the active session to the requested id', async () => {
    const jwt1 = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    const initialActive = client.getActiveSessionId();
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const r = await harness.callTool('onehome_set_auth', { input: jwt1 });
    const setAuth = JSON.parse((r.content[0] as { text: string }).text) as SetAuthResult;
    // After set_auth, the new session is active. Switch back to the
    // initial one.
    const r2 = await harness.callTool('onehome_set_active_session', {
      session_id: initialActive,
    });
    const out = JSON.parse((r2.content[0] as { text: string }).text);
    expect(out.active_session_id).toBe(initialActive);
    expect(client.getActiveSessionId()).toBe(initialActive);
    expect(setAuth.session_id).not.toBe(initialActive);
  });

  it('errors when the session_id is not registered', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const r = await harness.callTool('onehome_set_active_session', {
      session_id: 'session-does-not-exist',
    });
    expect(r.isError).toBeTruthy();
    expect((r.content[0] as { text: string }).text).toMatch(/no session/i);
  });

  it('rejects empty input', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const r = await harness.callTool('onehome_set_auth', { input: '   ' });
    expect(r.isError).toBeTruthy();
  });

  it('rejects URL inputs that lack ?token=', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerAuthTools(server, client)
    );
    const r = await harness.callTool('onehome_set_auth', {
      input: 'https://portal.onehome.com/en-US/properties/map',
    });
    expect(r.isError).toBeTruthy();
    expect((r.content[0] as { text: string }).text).toMatch(/no `token`/);
  });
});
