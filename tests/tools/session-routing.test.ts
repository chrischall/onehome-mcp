import { describe, it, expect, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { OneHomeClient } from '../../src/client.js';
import { registerPropertyTools } from '../../src/tools/properties.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { registerCompareTools } from '../../src/tools/compare.js';
import { registerPhotosTools } from '../../src/tools/photos.js';
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
    expect(client.sessionContextFor('xyz~canopy').groupId).toBe('G-B');
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
