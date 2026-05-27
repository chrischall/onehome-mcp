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
  auth_mode: string;
  auth_ready: boolean;
  auth_expires_at: number | null;
  session_context: Record<string, string | undefined>;
  input_fingerprint: string;
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
    expect(closeSpy).toHaveBeenCalledTimes(1); // Old transport closed.
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

  it('returns a token fingerprint, never the full input', async () => {
    const jwt = makeJwt({ sub: 'u1', exp: 9_999_999_999 });
    const transport = new FakeTransport();
    const { result } = await setAuthAndGet(transport, { input: jwt });
    expect(result.input_fingerprint).toMatch(/…/);
    expect(result.input_fingerprint.length).toBeLessThan(jwt.length);
    // Sanity: fingerprint should not contain the JWT signature in full.
    expect(result.input_fingerprint).not.toContain(jwt.slice(20, 60));
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
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // After the swap, the original FakeTransport's status() is no
    // longer what `bridgeStatus()` returns — the new DirectTransport
    // reports `authMode: 'env_token'` with the JWT bearer.
    const status = client.bridgeStatus();
    expect(status.authMode).toBe('env_token');
    expect(status.authReady).toBe(true);
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
