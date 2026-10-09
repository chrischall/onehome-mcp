import { describe, it, expect, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { OneHomeClient } from '../../src/client.js';
import { registerPropertyTools } from '../../src/tools/properties.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { registerCompareTools } from '../../src/tools/compare.js';
import { registerPhotosTools } from '../../src/tools/photos.js';
import { registerSavedTools } from '../../src/tools/saved.js';
import { registerSavedWithListingsTools } from '../../src/tools/saved-with-listings.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { registerByAddressTools } from '../../src/tools/by-address.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';
import type { BridgeStatus } from '../../src/transport.js';

/**
 * Regression for chrischall/fleet-audit#190: with two sessions
 * registered and the CANOPY one active, a `~HCAOR` listing is routed
 * to the HCAOR session — so its default group_id / saved_search_id
 * must come from the HCAOR session's context, not the active one's.
 */

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

function listing(id: string) {
  return {
    id,
    property: { ListPrice: 1, City: 'X', StateOrProvince: 'NC' },
    customProperty: {},
    media: [],
  };
}

function twoSessions(): { client: OneHomeClient; canopy: FakeTransport; hcaor: FakeTransport } {
  const canopy = new FakeTransport();
  canopy.setStatus({
    sessionContext: {
      mlsId: 'CANOPY',
      groupId: 'G-CANOPY',
      savedSearchId: 'S-CANOPY',
    } as BridgeStatus['sessionContext'],
  });
  const hcaor = new FakeTransport();
  hcaor.setStatus({
    sessionContext: {
      mlsId: 'HCAOR',
      groupId: 'G-HCAOR',
      savedSearchId: 'S-HCAOR',
    } as BridgeStatus['sessionContext'],
  });
  for (const t of [canopy, hcaor]) {
    t.on('ListingById', (v) => ok({ listingDetail: listing(v.listingId as string) }));
    t.on('MediaListingById', () => ok({ listingDetail: { media: [] } }));
  }
  const client = new OneHomeClient({ transport: canopy });
  client.registerSession(hcaor);
  // CANOPY stays active.
  return { client, canopy, hcaor };
}

async function call(
  client: OneHomeClient,
  register: (server: McpServer, client: OneHomeClient) => void,
  tool: string,
  args: Record<string, unknown>
) {
  harness = await createTestHarness((server) => register(server, client));
  const result = await harness.callTool(tool, args);
  expect(result.isError).toBeFalsy();
  return result;
}

describe('per-listing session context defaults (multi-session routing)', () => {
  it('client.sessionContextFor returns the routed session context', () => {
    const { client } = twoSessions();
    expect(client.sessionContextFor('abc~HCAOR').groupId).toBe('G-HCAOR');
    expect(client.sessionContextFor('abc~CANOPY').groupId).toBe('G-CANOPY');
    expect(client.sessionContextFor('abc').groupId).toBe('G-CANOPY');
    expect(client.sessionContextFor().groupId).toBe('G-CANOPY');
  });

  it('onehome_get_property uses the routed session group/saved-search ids', async () => {
    const { client, canopy, hcaor } = twoSessions();
    await call(client, registerPropertyTools, 'onehome_get_property', {
      listing_id: 'xyz~HCAOR',
    });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls[0]?.variables).toMatchObject({
      listingId: 'xyz~HCAOR',
      groupId: 'G-HCAOR',
      savedSearchId: 'S-HCAOR',
    });
  });

  it('onehome_bulk_get defaults each row from its own routed session', async () => {
    const { client, canopy, hcaor } = twoSessions();
    await call(client, registerBulkGetTools, 'onehome_bulk_get', {
      listing_ids: ['a~CANOPY', 'b~HCAOR'],
    });
    expect(canopy.calls[0]?.variables).toMatchObject({
      groupId: 'G-CANOPY',
      savedSearchId: 'S-CANOPY',
    });
    expect(hcaor.calls[0]?.variables).toMatchObject({
      groupId: 'G-HCAOR',
      savedSearchId: 'S-HCAOR',
    });
  });

  it('onehome_bulk_get still honours an explicit group_id for every row', async () => {
    const { client, hcaor } = twoSessions();
    await call(client, registerBulkGetTools, 'onehome_bulk_get', {
      group_id: 'EXPLICIT',
      listing_ids: ['b~HCAOR'],
    });
    expect(hcaor.calls[0]?.variables).toMatchObject({ groupId: 'EXPLICIT' });
  });

  it('onehome_compare_properties defaults each target from its routed session', async () => {
    const { client, canopy, hcaor } = twoSessions();
    await call(client, registerCompareTools, 'onehome_compare_properties', {
      targets: [{ listing_id: 'a~CANOPY' }, { listing_id: 'b~HCAOR' }],
    });
    expect(canopy.calls[0]?.variables).toMatchObject({ groupId: 'G-CANOPY' });
    expect(hcaor.calls[0]?.variables).toMatchObject({ groupId: 'G-HCAOR' });
  });

  it('onehome_get_property_photos uses the routed session group id', async () => {
    const { client, canopy, hcaor } = twoSessions();
    await call(client, registerPhotosTools, 'onehome_get_property_photos', {
      listing_id: 'xyz~HCAOR',
    });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls[0]?.variables).toMatchObject({ groupId: 'G-HCAOR' });
  });
});

/**
 * Regression for chrischall/fleet-audit#952: two shares in the SAME MLS
 * (e.g. two agents in CANOPY). The first-registered session used to win
 * every `~CANOPY` lookup, so onehome_set_active_session could not
 * select the second share for suffixed listing ids.
 */
describe('duplicate-MLS sessions', () => {
  function twoCanopy(): {
    client: OneHomeClient;
    a: FakeTransport;
    b: FakeTransport;
    hcaor: FakeTransport;
    bId: string;
    hcaorId: string;
  } {
    const mk = (group: string, mls = 'CANOPY') => {
      const t = new FakeTransport();
      t.setStatus({
        sessionContext: {
          mlsId: mls,
          groupId: group,
          savedSearchId: `S-${group}`,
        } as BridgeStatus['sessionContext'],
      });
      t.on('ListingById', (v) => ok({ listingDetail: listing(v.listingId as string) }));
      return t;
    };
    const a = mk('G-A');
    const b = mk('G-B');
    const hcaor = mk('G-H', 'HCAOR');
    const client = new OneHomeClient({ transport: a });
    const bId = client.registerSession(b);
    const hcaorId = client.registerSession(hcaor);
    return { client, a, b, hcaor, bId, hcaorId };
  }

  it('routes a matching ~MLS id to the ACTIVE session when it matches', () => {
    const { client, bId } = twoCanopy();
    client.setActiveSession(bId);
    expect(client.sessionContextFor('xyz~CANOPY').groupId).toBe('G-B');
  });

  it("matches a session's mlsId case-insensitively", () => {
    // Active session is HCAOR, so a CANOPY hit can only come from the
    // registry scan comparing against a lower-case reported mlsId.
    const hcaor = new FakeTransport();
    hcaor.setStatus({
      sessionContext: { mlsId: 'HCAOR', groupId: 'G-H' } as BridgeStatus['sessionContext'],
    });
    const lower = new FakeTransport();
    lower.setStatus({
      sessionContext: { mlsId: 'canopy', groupId: 'G-lower' } as BridgeStatus['sessionContext'],
    });
    const client = new OneHomeClient({ transport: hcaor });
    client.registerSession(lower);
    expect(client.sessionContextFor('xyz~CANOPY').groupId).toBe('G-lower');
  });

  it('does not treat a lower-case ~mls suffix as a routing hint', () => {
    // extractMlsSuffix only accepts upper-case MLS codes, so `~canopy`
    // falls through to the active session even though a CANOPY session
    // is registered.
    const { client, hcaorId } = twoCanopy();
    client.setActiveSession(hcaorId);
    expect(client.sessionContextFor('xyz~canopy').groupId).toBe('G-H');
    // Contrast: the upper-case suffix IS a hint — with two non-active
    // CANOPY sessions it is ambiguous and throws instead of falling back.
    expect(() => client.sessionContextFor('xyz~CANOPY')).toThrow(/ambiguous routing for ~CANOPY/);
  });

  it('onehome_get_property honours onehome_set_active_session for the second same-MLS share', async () => {
    const { client, a, b, bId } = twoCanopy();
    client.setActiveSession(bId);
    await call(client, registerPropertyTools, 'onehome_get_property', {
      listing_id: 'xyz~CANOPY',
    });
    expect(a.calls).toHaveLength(0);
    expect(b.calls[0]?.variables).toMatchObject({ groupId: 'G-B', savedSearchId: 'S-G-B' });
  });

  it('fails loudly, naming the candidates, when the active session does not match and several do', async () => {
    const { client, a, b, hcaorId } = twoCanopy();
    client.setActiveSession(hcaorId);
    expect(() => client.sessionContextFor('xyz~CANOPY')).toThrow(/session-1.*session-2/);
    expect(() => client.sessionContextFor('xyz~CANOPY')).toThrow(/onehome_set_active_session/);
    await expect(
      client.graphql({ operationName: 'ListingById', query: 'q', variables: { listingId: 'xyz~CANOPY' } })
    ).rejects.toThrow(/ambiguous/i);
    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(0);
  });

  it('still routes away from the active session when exactly one other session matches', () => {
    const { client } = twoCanopy();
    // session-1 (CANOPY, G-A) is active; ~HCAOR has one match.
    expect(client.sessionContextFor('xyz~HCAOR').groupId).toBe('G-H');
  });
});

/**
 * Regression for chrischall/fleet-audit#1077: a group / saved-search id
 * belonging to a NON-active session must be sent with THAT session's
 * bearer (and defaults must come from that session's context), not the
 * active session's.
 */
describe('group / saved-search id routing', () => {
  function scoped(): { client: OneHomeClient; canopy: FakeTransport; hcaor: FakeTransport } {
    const { client, canopy, hcaor } = twoSessions();
    for (const [t, g, s] of [
      [canopy, 'G-CANOPY', 'S-CANOPY'],
      [hcaor, 'G-HCAOR', 'S-HCAOR'],
    ] as const) {
      t.on('GetSavedSearchBySearchId', (v) => {
        expect(v.searchId).toBe(s);
        return ok({ savedSearch: { id: s, name: s, listingIds: [`l~${g}`] } });
      });
      t.on('GetSavedListings', (v) => {
        expect(v.groupId).toBe(g);
        expect(v.savedSearchId).toBe(s);
        return ok({ listingsBySavedSearchId: { pageInfo: {}, listings: [listing(`l-${g}`)] } });
      });
      t.on('GetListings', () => ok({ listings: { pageInfo: { totalElements: 0 }, listings: [] } }));
      t.on('ListingSuggestionsSearch', () => ok({ listingSuggestionsSearch: [] }));
    }
    return { client, canopy, hcaor };
  }

  it('routes a request carrying another session’s savedSearchId / searchId / groupId to it', async () => {
    const { client, canopy, hcaor } = scoped();
    await client.graphql({ operationName: 'GetSavedSearchBySearchId', query: 'q', variables: { searchId: 'S-HCAOR' } });
    await client.graphql({ operationName: 'GetListings', query: 'q', variables: { groupId: 'G-HCAOR' } });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls.map((c) => c.operationName)).toEqual(['GetSavedSearchBySearchId', 'GetListings']);
  });

  it('falls back to the active session for ids no session owns', async () => {
    const { client, canopy, hcaor } = scoped();
    await client.graphql({ operationName: 'GetListings', query: 'q', variables: { groupId: 'G-UNKNOWN' } });
    expect(canopy.calls).toHaveLength(1);
    expect(hcaor.calls).toHaveLength(0);
  });

  it('client.sessionContextForIds resolves the owning session context', () => {
    const { client } = scoped();
    expect(client.sessionContextForIds({ savedSearchId: 'S-HCAOR' }).groupId).toBe('G-HCAOR');
    expect(client.sessionContextForIds({ groupId: 'G-HCAOR' }).savedSearchId).toBe('S-HCAOR');
    expect(client.sessionContextForIds({}).groupId).toBe('G-CANOPY');
    expect(client.sessionContextForIds({ groupId: 'nope' }).groupId).toBe('G-CANOPY');
  });

  it('onehome_get_saved_search fetches a non-active session’s saved search with its bearer', async () => {
    const { client, canopy, hcaor } = scoped();
    await call(client, registerSavedTools, 'onehome_get_saved_search', { saved_search_id: 'S-HCAOR' });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls).toHaveLength(1);
  });

  it('onehome_get_saved_search_with_listings defaults group_id from the owning session', async () => {
    const { client, canopy, hcaor } = scoped();
    await call(client, registerSavedWithListingsTools, 'onehome_get_saved_search_with_listings', {
      saved_search_id: 'S-HCAOR',
    });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls.map((c) => c.operationName)).toEqual(['GetSavedSearchBySearchId', 'GetSavedListings']);
  });

  it('onehome_search_properties routes by saved_search_id and defaults group_id from that session', async () => {
    const { client, canopy, hcaor } = scoped();
    await call(client, registerSearchTools, 'onehome_search_properties', { saved_search_id: 'S-HCAOR' });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls.map((c) => c.operationName)).toEqual(['GetSavedSearchBySearchId', 'GetSavedListings']);
  });

  it('onehome_search_properties with another session’s group_id falls back to that session’s saved search', async () => {
    const { client, canopy, hcaor } = scoped();
    await call(client, registerSearchTools, 'onehome_search_properties', { group_id: 'G-HCAOR' });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls.map((c) => c.operationName)).toEqual([
      'GetListings',
      'GetSavedSearchBySearchId',
      'GetSavedListings',
    ]);
  });

  it('onehome_get_by_address with another session’s group_id walks that session’s pool', async () => {
    const { client, canopy, hcaor } = scoped();
    await call(client, registerByAddressTools, 'onehome_get_by_address', {
      address: '1 Nowhere Rd',
      group_id: 'G-HCAOR',
    });
    expect(canopy.calls).toHaveLength(0);
    expect(hcaor.calls.map((c) => c.operationName)).toEqual([
      'ListingSuggestionsSearch',
      'GetSavedSearchBySearchId',
      'GetSavedListings',
    ]);
  });
});
