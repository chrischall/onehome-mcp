import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerSearchTools } from '../../src/tools/search.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';
import type { RawListingDetail } from '../../src/format.js';

function sampleListing(id: string, price: number): RawListingDetail {
  return {
    id,
    property: {
      ListPrice: price,
      BedroomsTotal: 3,
      BathroomsTotalInteger: 2,
      LivingArea: 1500,
      LivingAreaTotal: 1500,
      City: 'Lake Lure',
      StateOrProvince: 'NC',
      PostalCode: '28746',
      StreetNumber: '1',
      StreetName: 'Lake',
      StreetSuffix: 'Way',
      StandardStatus: 'Active',
      Latitude: 35.4,
      Longitude: -82.2,
    },
    customProperty: {},
    media: [],
  };
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

interface SearchResult {
  count?: number;
  page_info?: unknown;
  saved_search_id?: string;
  listings?: Array<{ listing_id?: string; address_full?: string; list_price?: number }>;
  suggestions?: Array<{
    listing_id?: string;
    source_listing_id?: string;
    address_full?: string;
    list_price?: number;
    primary_thumbnail_url?: string;
    url?: string;
  }>;
}

async function runTool(
  transport: FakeTransport,
  name: string,
  args: Record<string, unknown>
): Promise<SearchResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) => registerSearchTools(server, client));
  const result = await harness.callTool(name, args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

describe('search tool — groups + saved searches', () => {
  it('formats listings from the default GetListings path', async () => {
    const transport = new FakeTransport();
    transport.on('GetListings', () =>
      ok({
        listings: {
          pageInfo: { totalElements: 2 },
          listings: [sampleListing('A', 100000), sampleListing('B', 200000)],
        },
      })
    );
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g1',
    });
    expect(result.count).toBe(2);
    expect(result.listings?.[0]?.listing_id).toBe('A');
    expect(result.listings?.[0]?.address_full).toContain('Lake Lure');
    expect(result.listings?.[0]?.list_price).toBe(100000);
    expect(result.page_info).toEqual({ totalElements: 2 });
  });

  it('resolves saved-search listingIds first, then inflates via listingsBySavedSearchId', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', (variables) => {
      expect(variables.searchId).toBe('ss-1');
      return ok({
        savedSearch: {
          id: 'ss-1',
          name: 'Lake Lure',
          listingIds: ['Z'],
        },
      });
    });
    transport.on('GetSavedListings', (variables) => {
      expect(variables.savedSearchId).toBe('ss-1');
      expect(variables.groupId).toBe('g1');
      expect(variables.listingIds).toEqual(['Z']);
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('Z', 300000)],
        },
      });
    });
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g1',
      saved_search_id: 'ss-1',
    });
    expect(result.saved_search_id).toBe('ss-1');
    expect((result as Record<string, unknown>).saved_search_name).toBe(
      'Lake Lure'
    );
    expect(result.count).toBe(1);
    expect(result.listings?.[0]?.listing_id).toBe('Z');
  });

  it('short-circuits to an empty result when the saved search has no listings', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: [] } })
    );
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g1',
      saved_search_id: 'ss-1',
    });
    expect(result.count).toBe(0);
    expect(result.listings).toEqual([]);
    // The second GraphQL call should NOT have fired.
    expect(transport.calls.find((c) => c.operationName === 'GetSavedListings'))
      .toBeUndefined();
  });

  it('defaults group_id + saved_search_id from session context', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-ctx' },
    });
    transport.on('GetSavedSearchBySearchId', (vars) => {
      expect(vars.searchId).toBe('ss-ctx');
      return ok({ savedSearch: { id: 'ss-ctx', listingIds: ['L1'] } });
    });
    transport.on('GetSavedListings', (vars) => {
      expect(vars.groupId).toBe('g-ctx');
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('L1', 555000)],
        },
      });
    });
    const result = await runTool(transport, 'onehome_search_properties', {});
    expect(result.count).toBe(1);
  });

  // Issue #27: consumer-share sessions can't reach the raw `listings(groupId)`
  // endpoint — it returns an empty page. When the session context already
  // carries a savedSearchId the user clearly wants those listings, so the
  // tool should silently fall back to the saved-search path instead of
  // returning a misleading `{ count: 0 }`.
  it('falls back to saved-search path when raw listings returns 0 but session has a savedSearchId', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-consumer', savedSearchId: 'ss-consumer' },
    });
    transport.on('GetListings', (vars) => {
      expect(vars.groupId).toBe('g-consumer');
      // Consumer-share groups always come back empty from this endpoint.
      return ok({ listings: { pageInfo: { totalElements: 0 }, listings: [] } });
    });
    transport.on('GetSavedSearchBySearchId', (vars) => {
      expect(vars.searchId).toBe('ss-consumer');
      return ok({
        savedSearch: {
          id: 'ss-consumer',
          name: 'Consumer share',
          listingIds: ['CON-1', 'CON-2'],
        },
      });
    });
    transport.on('GetSavedListings', (vars) => {
      expect(vars.savedSearchId).toBe('ss-consumer');
      expect(vars.groupId).toBe('g-consumer');
      expect(vars.listingIds).toEqual(['CON-1', 'CON-2']);
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 2 },
          listings: [sampleListing('CON-1', 100000), sampleListing('CON-2', 200000)],
        },
      });
    });
    // Caller supplied only group_id — no saved_search_id arg.
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g-consumer',
    });
    expect(result.count).toBe(2);
    expect(result.saved_search_id).toBe('ss-consumer');
    expect(result.listings?.[0]?.listing_id).toBe('CON-1');
    // The raw listings call must have happened first; fallback is conditional.
    expect(transport.calls.map((c) => c.operationName)).toEqual([
      'GetListings',
      'GetSavedSearchBySearchId',
      'GetSavedListings',
    ]);
  });

  // The ctx.savedSearchId is scoped to ctx.groupId. When the caller asks
  // for a DIFFERENT group, falling back to that saved search would inflate
  // listings from the wrong group. Only fall back when the requested group
  // is the one the saved search belongs to.
  it('does NOT fall back to ctx.savedSearchId when the explicit group_id is a different group', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      // Saved search ss-ctx belongs to g-ctx, NOT to the requested group.
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-ctx' },
    });
    transport.on('GetListings', (vars) => {
      expect(vars.groupId).toBe('g-other');
      return ok({ listings: { pageInfo: { totalElements: 0 }, listings: [] } });
    });
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerSearchTools(server, client)
    );
    const result = await harness.callTool('onehome_search_properties', {
      group_id: 'g-other',
    });
    // Must surface the clear error rather than inflating the wrong group's
    // saved search.
    expect(result.isError).toBe(true);
    const first = result.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    expect(first.text).toMatch(/saved_search_id/);
    // The cross-group saved search must NOT have been fetched.
    const ops = transport.calls.map((c) => c.operationName);
    expect(ops).toEqual(['GetListings']);
    expect(ops).not.toContain('GetSavedSearchBySearchId');
    expect(ops).not.toContain('GetSavedListings');
  });

  it('does fall back to ctx.savedSearchId when the explicit group_id matches ctx.groupId', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-ctx' },
    });
    transport.on('GetListings', () =>
      ok({ listings: { pageInfo: { totalElements: 0 }, listings: [] } })
    );
    transport.on('GetSavedSearchBySearchId', (vars) => {
      expect(vars.searchId).toBe('ss-ctx');
      return ok({ savedSearch: { id: 'ss-ctx', listingIds: ['X'] } });
    });
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('X', 100000)],
        },
      })
    );
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g-ctx',
    });
    expect(result.count).toBe(1);
    expect(result.saved_search_id).toBe('ss-ctx');
  });

  it('does NOT fall back when the raw listings call returns non-zero results', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      // Even though the session has a savedSearchId, the raw call worked
      // — this is the agent-session shape. Don't double-fetch.
      sessionContext: { groupId: 'g-agent', savedSearchId: 'ss-agent' },
    });
    transport.on('GetListings', () =>
      ok({
        listings: {
          pageInfo: { totalElements: 2 },
          listings: [sampleListing('A', 100000), sampleListing('B', 200000)],
        },
      })
    );
    const result = await runTool(transport, 'onehome_search_properties', {
      group_id: 'g-agent',
    });
    expect(result.count).toBe(2);
    expect(result.saved_search_id).toBeUndefined();
    // Only the raw listings call should have fired.
    expect(transport.calls.map((c) => c.operationName)).toEqual(['GetListings']);
  });

  it('surfaces a clear error when raw listings returns 0 and session has no savedSearchId', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'env_token',
      sessionContext: { groupId: 'g-orphan' },
    });
    transport.on('GetListings', () =>
      ok({ listings: { pageInfo: { totalElements: 0 }, listings: [] } })
    );
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerSearchTools(server, client)
    );
    const result = await harness.callTool('onehome_search_properties', {
      group_id: 'g-orphan',
    });
    // MCP returns an error result instead of throwing — check isError.
    expect(result.isError).toBe(true);
    const first = result.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    expect(first.text).toMatch(/consumer/i);
    expect(first.text).toMatch(/saved_search_id/);
    expect(transport.calls.map((c) => c.operationName)).toEqual(['GetListings']);
  });
});

describe('search tool — suggestions', () => {
  it('formats free-text address suggestions', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', (variables) => {
      expect(variables.browseParameter).toBe('4276702');
      return ok({
        listingSuggestionsSearch: [
          {
            id: 'EYxAbC123',
            listingId: '4276702',
            city: 'Lake Lure',
            stateOrProvince: 'NC',
            postalCode: '28746',
            streetNumber: '126',
            streetName: 'Sleeping Bear',
            streetSuffix: 'Lane',
            bedroomsTotal: 3,
            bathroomsTotalInteger: 2,
            listPrice: 629000,
            media: [{ Image: { Thumbnail: { mediaUrl: 'https://cdn/x.jpg' } } }],
          },
        ],
      });
    });
    const result = await runTool(transport, 'onehome_search_suggestions', {
      query: '4276702',
    });
    expect(result.count).toBe(1);
    const first = result.suggestions?.[0]!;
    expect(first.listing_id).toBe('EYxAbC123');
    expect(first.source_listing_id).toBe('4276702');
    expect(first.address_full).toContain('Sleeping Bear');
    expect(first.list_price).toBe(629000);
    expect(first.primary_thumbnail_url).toBe('https://cdn/x.jpg');
    expect(first.url).toBe(
      'https://portal.onehome.com/en-US/properties/EYxAbC123'
    );
  });

  it('omits url when the suggestion has no resolvable listing id', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          // No `id` or `listingId` — defensive against a sparse upstream row.
          { city: 'Lake Lure', stateOrProvince: 'NC' },
        ],
      })
    );
    const result = await runTool(transport, 'onehome_search_suggestions', {
      query: 'partial',
    });
    expect(result.suggestions?.[0]?.url).toBeUndefined();
  });
});
