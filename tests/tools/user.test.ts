import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { FakeTransport, createTestHarness } from '../helpers.js';

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
