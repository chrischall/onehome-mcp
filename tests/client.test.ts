import { describe, it, expect } from 'vitest';
import { OneHomeClient, GraphQLResponseError } from '../src/client.js';
import { FakeTransport, ok } from './helpers.js';
import type { BridgeStatus } from '../src/transport.js';

describe('OneHomeClient.graphql', () => {
  it('unwraps `data` on a 200 response', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ok({ user: { userId: 'u1' } }));
    const client = new OneHomeClient({ transport });
    const result = await client.graphql<{ user: { userId: string } }>({
      operationName: 'GetOneHomeUser',
      query: '{ user { userId } }',
    });
    expect(result.user.userId).toBe('u1');
  });

  it('throws GraphQLResponseError when `errors` is non-empty', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      errors: [{ message: 'unauthorized' }, { message: 'forbidden' }],
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toBeInstanceOf(GraphQLResponseError);
  });

  it('throws a plain Error on HTTP >= 400', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      status: 500,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws when data is missing on a 2xx response', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    await expect(
      client.graphql({
        operationName: 'GetOneHomeUser',
        query: '{ user { userId } }',
      })
    ).rejects.toThrow(/no `data`/);
  });

  it('graphqlRaw returns the full envelope including errors', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ({
      data: null,
      errors: [{ message: 'oops' }],
      status: 200,
      url: 'https://services.onehome.com/graphql',
    }));
    const client = new OneHomeClient({ transport });
    const env = await client.graphqlRaw({
      operationName: 'GetOneHomeUser',
      query: '{ user { userId } }',
    });
    expect(env.errors).toEqual([{ message: 'oops' }]);
    expect(env.status).toBe(200);
  });
});

/**
 * Multi-session registry: `OneHomeClient` now keeps a map of transports
 * keyed by `session_id`, with one designated as active. Single-session
 * use (today's behavior) is the special case where the map has one
 * entry and `activeSessionId` is that entry.
 */
describe('OneHomeClient session registry', () => {
  it('registers the constructor transport as the initial active session', () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    const sessions = client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(client.getActiveSessionId());
    expect(sessions[0]!.sessionId).toMatch(/^session-\d+$/);
  });

  it('routes graphql/rest through the active session by default', async () => {
    const transport = new FakeTransport();
    transport.on('GetOneHomeUser', () => ok({ user: { id: 'u1' } }));
    const client = new OneHomeClient({ transport });
    await client.graphql({
      operationName: 'GetOneHomeUser',
      query: '{ user { id } }',
    });
    expect(transport.calls).toHaveLength(1);
  });

  it('registers additional sessions without replacing the active one', () => {
    const t1 = new FakeTransport();
    const t2 = new FakeTransport();
    const client = new OneHomeClient({ transport: t1 });
    const firstId = client.getActiveSessionId();
    const newId = client.registerSession(t2);
    expect(newId).not.toBe(firstId);
    // Active session unchanged after additive registration.
    expect(client.getActiveSessionId()).toBe(firstId);
    const sessions = client.listSessions();
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(
      [firstId, newId].sort()
    );
  });

  it('setActiveSession switches which session graphql/rest target', async () => {
    const t1 = new FakeTransport();
    t1.on('Ping', () => ok({ from: 't1' }));
    const t2 = new FakeTransport();
    t2.on('Ping', () => ok({ from: 't2' }));
    const client = new OneHomeClient({ transport: t1 });
    const id2 = client.registerSession(t2);
    client.setActiveSession(id2);
    const result = await client.graphql<{ from: string }>({
      operationName: 'Ping',
      query: '{ ping }',
    });
    expect(result.from).toBe('t2');
    expect(t1.calls).toHaveLength(0);
    expect(t2.calls).toHaveLength(1);
  });

  it('setActiveSession throws on unknown session_id', () => {
    const client = new OneHomeClient({ transport: new FakeTransport() });
    expect(() => client.setActiveSession('session-99')).toThrow(
      /no session/i
    );
  });

  it('routes by MLS suffix in listing_id when registered sessions cover different MLSes', async () => {
    // Session A — CANOPY MLS
    const tCanopy = new FakeTransport();
    tCanopy.setStatus({
      sessionContext: { mlsId: 'CANOPY', groupId: 'G-CANOPY' } as BridgeStatus['sessionContext'],
    });
    tCanopy.on('ListingById', () => ok({ listingDetail: { id: 'A~CANOPY', source: 'canopy' } }));
    // Session B — HCAOR MLS
    const tHcaor = new FakeTransport();
    tHcaor.setStatus({
      sessionContext: { mlsId: 'HCAOR', groupId: 'G-HCAOR' } as BridgeStatus['sessionContext'],
    });
    tHcaor.on('ListingById', () => ok({ listingDetail: { id: 'B~HCAOR', source: 'hcaor' } }));

    const client = new OneHomeClient({ transport: tCanopy });
    client.registerSession(tHcaor);

    // listing_id with ~CANOPY → routes to tCanopy
    const a = await client.graphql<{ listingDetail: { source: string } }>({
      operationName: 'ListingById',
      query: 'q',
      variables: { listingId: 'EYxOzZS~CANOPY', groupId: 'G-CANOPY' },
    });
    expect(a.listingDetail.source).toBe('canopy');

    // listing_id with ~HCAOR → routes to tHcaor
    const b = await client.graphql<{ listingDetail: { source: string } }>({
      operationName: 'ListingById',
      query: 'q',
      variables: { listingId: 'EYxOzZS~HCAOR', groupId: 'G-HCAOR' },
    });
    expect(b.listingDetail.source).toBe('hcaor');

    expect(tCanopy.calls).toHaveLength(1);
    expect(tHcaor.calls).toHaveLength(1);
  });

  it('routes by MLS suffix in osks[] variable too', async () => {
    const tCanopy = new FakeTransport();
    tCanopy.setStatus({
      sessionContext: { mlsId: 'CANOPY' } as BridgeStatus['sessionContext'],
    });
    tCanopy.on('GetSavedListings', () => ok({ listingsBySavedSearchId: [] }));
    const tHcaor = new FakeTransport();
    tHcaor.setStatus({
      sessionContext: { mlsId: 'HCAOR' } as BridgeStatus['sessionContext'],
    });
    tHcaor.on('GetSavedListings', () => ok({ listingsBySavedSearchId: [] }));

    const client = new OneHomeClient({ transport: tHcaor });
    client.registerSession(tCanopy);
    // active is tHcaor, but osks[0] suffix is ~CANOPY → should hit tCanopy
    await client.graphql({
      operationName: 'GetSavedListings',
      query: 'q',
      variables: { osks: ['XYZ~CANOPY', 'ABC~CANOPY'] },
    });
    expect(tCanopy.calls).toHaveLength(1);
    expect(tHcaor.calls).toHaveLength(0);
  });

  it('falls back to active session when no listing context or no MLS match', async () => {
    const tA = new FakeTransport();
    tA.setStatus({
      sessionContext: { mlsId: 'CANOPY' } as BridgeStatus['sessionContext'],
    });
    tA.on('GetListings', () => ok({ listings: { listings: [] } }));
    const tB = new FakeTransport();
    tB.setStatus({
      sessionContext: { mlsId: 'HCAOR' } as BridgeStatus['sessionContext'],
    });
    tB.on('GetListings', () => ok({ listings: { listings: [] } }));

    const client = new OneHomeClient({ transport: tA });
    client.registerSession(tB);
    // No listing_id; no MLS context → active session (tA).
    await client.graphql({
      operationName: 'GetListings',
      query: 'q',
      variables: { groupId: 'g' },
    });
    expect(tA.calls).toHaveLength(1);
    expect(tB.calls).toHaveLength(0);

    // Unknown MLS suffix → falls back to active (tA).
    await client.graphql({
      operationName: 'GetListings',
      query: 'q',
      variables: { listingId: 'EYxOzZS~UNKNOWN' },
    });
    expect(tA.calls).toHaveLength(2);
    expect(tB.calls).toHaveLength(0);
  });

  it('with a single registered session, routing always picks that session (backward compat)', async () => {
    const t = new FakeTransport();
    t.setStatus({
      sessionContext: { mlsId: 'CANOPY' } as BridgeStatus['sessionContext'],
    });
    t.on('ListingById', () => ok({ listingDetail: { id: 'X' } }));
    const client = new OneHomeClient({ transport: t });
    // listing_id with a different MLS — single-session case should still
    // route there (no other choice).
    await client.graphql({
      operationName: 'ListingById',
      query: 'q',
      variables: { listingId: 'EYxOzZS~HCAOR' },
    });
    expect(t.calls).toHaveLength(1);
  });

  it('bridgeStatus() reports the active session by default; bridgeStatus(id) targets a specific session', () => {
    const t1 = new FakeTransport();
    t1.setStatus({ authMode: 'env_token' });
    const t2 = new FakeTransport();
    t2.setStatus({ authMode: 'magic_link' });
    const client = new OneHomeClient({ transport: t1 });
    const id2 = client.registerSession(t2);

    expect(client.bridgeStatus().authMode).toBe('env_token');
    expect(client.bridgeStatus(id2).authMode).toBe('magic_link');
  });

  it('rest() routes through the active session (REST calls have no listing context)', async () => {
    const tA = new FakeTransport();
    tA.onRest('/locallogic/scores', () => ({
      status: 200,
      url: 'x',
      data: { from: 'tA' },
      ok: true,
    }));
    const tB = new FakeTransport();
    tB.onRest('/locallogic/scores', () => ({
      status: 200,
      url: 'x',
      data: { from: 'tB' },
      ok: true,
    }));
    const client = new OneHomeClient({ transport: tA });
    client.registerSession(tB);
    const r = await client.rest<{ from: string }>('/locallogic/scores?lat=1&lng=2');
    expect((r.data as { from: string }).from).toBe('tA');
  });
});
