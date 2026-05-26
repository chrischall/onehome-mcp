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
  });
});
