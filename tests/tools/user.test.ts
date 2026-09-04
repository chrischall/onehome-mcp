import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { FakeTransport, createTestHarness, ok } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

interface SessionContextResult {
  active_session_id: string;
  sessions: Array<{
    session_id: string;
    auth_mode: string;
    auth_ready: boolean;
    auth_expires_at: number | null;
    auth_expires_at_iso?: string | null;
    session_context: Record<string, string | undefined>;
  }>;
}

async function callSessionContext(
  client: OneHomeClient
): Promise<SessionContextResult> {
  harness = await createTestHarness((server) =>
    registerUserTools(server, client)
  );
  const r = await harness.callTool('onehome_get_session_context', {});
  const first = r.content[0]!;
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text) as SessionContextResult;
}

describe('onehome_get_session_context — multi-session listing', () => {
  it('with a single registered session, returns a one-entry sessions[] with active_session_id', async () => {
    const t = new FakeTransport();
    t.setStatus({
      authMode: 'env_token',
      authReady: true,
      authExpiresAt: null,
      sessionContext: { groupId: 'G-1', mlsId: 'CANOPY' },
    });
    const client = new OneHomeClient({ transport: t });
    const out = await callSessionContext(client);
    expect(out.active_session_id).toBe(client.getActiveSessionId());
    expect(out.sessions).toHaveLength(1);
    const s = out.sessions[0]!;
    expect(s.session_id).toBe(client.getActiveSessionId());
    expect(s.auth_mode).toBe('env_token');
    expect(s.auth_ready).toBe(true);
    expect(s.session_context.groupId).toBe('G-1');
    expect(s.session_context.mlsId).toBe('CANOPY');
  });

  it('lists every registered session with its own context and auth state', async () => {
    const t1 = new FakeTransport();
    t1.setStatus({
      authMode: 'env_token',
      authReady: true,
      authExpiresAt: null,
      sessionContext: { groupId: 'G-CANOPY', mlsId: 'CANOPY' },
    });
    const t2 = new FakeTransport();
    t2.setStatus({
      authMode: 'magic_link',
      authReady: true,
      authExpiresAt: 9_999_999_999_000,
      sessionContext: { groupId: 'G-HCAOR', mlsId: 'HCAOR' },
    });
    const client = new OneHomeClient({ transport: t1 });
    const newId = client.registerSession(t2);

    const out = await callSessionContext(client);
    expect(out.sessions).toHaveLength(2);
    const byId = new Map(out.sessions.map((s) => [s.session_id, s]));
    const first = byId.get(client.getActiveSessionId())!;
    const second = byId.get(newId)!;
    expect(first.session_context.mlsId).toBe('CANOPY');
    expect(second.session_context.mlsId).toBe('HCAOR');
    expect(second.auth_mode).toBe('magic_link');
    expect(second.auth_expires_at).toBe(9_999_999_999_000);
    expect(second.auth_expires_at_iso).toBeTypeOf('string');
  });

  it('active_session_id matches the currently-active session in the list', async () => {
    const t1 = new FakeTransport();
    t1.setStatus({ authMode: 'env_token', authReady: true });
    const t2 = new FakeTransport();
    t2.setStatus({ authMode: 'magic_link', authReady: true });
    const client = new OneHomeClient({ transport: t1 });
    const id2 = client.registerSession(t2);
    client.setActiveSession(id2);
    const out = await callSessionContext(client);
    expect(out.active_session_id).toBe(id2);
    // Sanity — id2 actually appears in sessions[].
    expect(out.sessions.find((s) => s.session_id === id2)).toBeTruthy();
  });
});

/**
 * `onehome_get_user` advertised `view` in its schema while BOTH of its exits
 * called `minifiedResult` directly, so the parameter was a no-op on every path
 * a caller can reach — a schema promising a response shape the handler never
 * honoured. Both paths are covered here because there is no route through this
 * tool that does not take one of them.
 */
describe('onehome_get_user — the `view` parameter is honoured on BOTH exits', () => {
  const userPayload = {
    user: {
      id: 'U-1',
      firstName: 'Chris',
      lastName: 'Chall',
      email: 'chris@example.com',
      groups: [
        {
          id: 'G-1',
          contactId: 'C-1',
          agent: { id: 'A-1', fullName: 'Agent Smith', email: 'agent@example.com' },
        },
      ],
    },
  };

  async function callUser(
    t: FakeTransport,
    args: Record<string, unknown> = {}
  ): Promise<string> {
    const client = new OneHomeClient({ transport: t });
    harness = await createTestHarness((server) => registerUserTools(server, client));
    const r = await harness.callTool('onehome_get_user', args);
    const first = r.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    return first.text;
  }

  it('answers the GraphQL path through viewResponse — accepts view, stays minified', async () => {
    const t = new FakeTransport().on('GetOneHomeUser', () => ok(userPayload));
    const text = await callUser(t, { view: 'full' });
    const parsed = JSON.parse(text);
    expect(parsed.source).toBe('graphql');
    expect(parsed.user_id).toBe('U-1');
    // Minified on every rung: one line, no pretty-printing.
    expect(text.includes('\n')).toBe(false);
  });

  // This projection names its own fields and none of them is a picture, so
  // compact and full must agree BYTE FOR BYTE. Pinned deliberately: a `view`
  // that quietly changed a user record would be far worse than one that did
  // nothing, and this is the assertion that would catch it.
  it('returns identical bytes on compact and full for the GraphQL path', async () => {
    const t = new FakeTransport().on('GetOneHomeUser', () => ok(userPayload));
    const compact = await callUser(t);
    await harness?.close();
    harness = undefined;
    const t2 = new FakeTransport().on('GetOneHomeUser', () => ok(userPayload));
    const full = await callUser(t2, { view: 'full' });
    expect(compact).toBe(full);
  });

  it('answers the session-context fallback through viewResponse too', async () => {
    // `user { }` is agent-only; a magic-link consumer share gets Access Denied
    // and drops to the checkToken context. That exit called `minifiedResult`
    // as well, so it needed its own test rather than an assumption.
    const t = new FakeTransport().on('GetOneHomeUser', () => ({
      data: undefined,
      errors: [{ message: 'Access Denied' }],
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    t.setStatus({
      sessionContext: { groupId: 'G-9', contactId: 'C-9', email: 'share@example.com' },
    });
    const text = await callUser(t, { view: 'compact' });
    const parsed = JSON.parse(text);
    expect(parsed.source).toBe('session_context');
    expect(parsed.group_id).toBe('G-9');
    expect(text.includes('\n')).toBe(false);
  });

  // `view` is a RESPONSE-shape argument; OneHome has never heard of it. Two
  // sibling repos shipped a handler that forwarded its whole args object into
  // a query string and sent `view=compact` to the live API.
  it('never forwards `view` upstream', async () => {
    const t = new FakeTransport().on('GetOneHomeUser', () => ok(userPayload));
    await callUser(t, { view: 'full' });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.operationName).toBe('GetOneHomeUser');
    expect(JSON.stringify(t.calls[0]!.variables ?? {})).not.toContain('view');
  });
});
