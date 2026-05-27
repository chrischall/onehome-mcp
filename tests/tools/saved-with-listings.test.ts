import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerSavedWithListingsTools } from '../../src/tools/saved-with-listings.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';
import type { RawListingDetail } from '../../src/format.js';

function sampleListing(
  id: string,
  price: number,
  opts: { withDescription?: boolean } = {}
): RawListingDetail {
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
      ...(opts.withDescription
        ? { PublicRemarks: 'Lakefront with private dock.' }
        : {}),
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

interface ComboResult {
  saved_search?: {
    saved_search_id?: string;
    name?: string;
    listing_count?: number;
  };
  listings?: Array<{
    listing_id?: string;
    address_full?: string;
    list_price?: number;
    description?: string;
  }>;
  count?: number;
  group_id?: string;
  page_info?: unknown;
}

async function runCombo(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<ComboResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) =>
    registerSavedWithListingsTools(server, client)
  );
  const result = await harness.callTool(
    'onehome_get_saved_search_with_listings',
    args
  );
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

describe('onehome_get_saved_search_with_listings', () => {
  it('combines GetSavedSearchBySearchId + GetSavedListings into one response', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', (vars) => {
      expect(vars.searchId).toBe('ss-1');
      return ok({
        savedSearch: {
          id: 'ss-1',
          name: 'Lake Lure under $700k',
          setType: 'AGENT_SAVED_SEARCH',
          listingIds: ['A', 'B'],
        },
      });
    });
    transport.on('GetSavedListings', (vars) => {
      expect(vars.savedSearchId).toBe('ss-1');
      expect(vars.groupId).toBe('g1');
      expect(vars.listingIds).toEqual(['A', 'B']);
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 2 },
          listings: [sampleListing('A', 100000), sampleListing('B', 200000)],
        },
      });
    });
    const result = await runCombo(transport, {
      saved_search_id: 'ss-1',
      group_id: 'g1',
    });
    expect(result.saved_search?.saved_search_id).toBe('ss-1');
    expect(result.saved_search?.name).toBe('Lake Lure under $700k');
    expect(result.saved_search?.listing_count).toBe(2);
    expect(result.count).toBe(2);
    expect(result.listings?.[0]?.listing_id).toBe('A');
    expect(result.listings?.[0]?.list_price).toBe(100000);
    expect(result.listings?.[1]?.listing_id).toBe('B');
    expect(result.page_info).toEqual({ totalElements: 2 });
  });

  it('defaults saved_search_id and group_id from session context', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-ctx' },
    });
    transport.on('GetSavedSearchBySearchId', (vars) => {
      expect(vars.searchId).toBe('ss-ctx');
      return ok({
        savedSearch: { id: 'ss-ctx', name: 'Defaulted', listingIds: ['X'] },
      });
    });
    transport.on('GetSavedListings', (vars) => {
      expect(vars.groupId).toBe('g-ctx');
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('X', 555000)],
        },
      });
    });
    const result = await runCombo(transport, {});
    expect(result.saved_search?.saved_search_id).toBe('ss-ctx');
    expect(result.count).toBe(1);
  });

  it('short-circuits when the saved search has no listingIds (does not call GetSavedListings)', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({
        savedSearch: {
          id: 'ss-empty',
          name: 'No homes yet',
          listingIds: [],
        },
      })
    );
    const result = await runCombo(transport, {
      saved_search_id: 'ss-empty',
      group_id: 'g1',
    });
    expect(result.count).toBe(0);
    expect(result.listings).toEqual([]);
    expect(result.saved_search?.name).toBe('No homes yet');
    expect(
      transport.calls.find((c) => c.operationName === 'GetSavedListings')
    ).toBeUndefined();
  });

  it('never surfaces description on listings (card projection has no PublicRemarks)', async () => {
    // FRAGMENT_LISTING_CARD does not request PublicRemarks, so listings
    // returned here never carry a description. Even if a future regression
    // started threading PublicRemarks through the mock, the tool must not
    // expose it — callers needing prose call onehome_get_property(listing_id).
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['A'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('A', 100000, { withDescription: true })],
        },
      })
    );
    const result = await runCombo(transport, {
      saved_search_id: 'ss-1',
      group_id: 'g1',
    });
    expect(result.listings?.[0]?.description).toBeUndefined();
  });

  it('passes pagination through to GetSavedListings', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['A', 'B', 'C'] } })
    );
    transport.on('GetSavedListings', (vars) => {
      expect(vars.pageInput).toEqual({ pageNum: 1, size: 25 });
      expect(vars.sort).toEqual({
        name: 'property.ListPrice',
        order: 'ASC',
      });
      return ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 3 },
          listings: [sampleListing('B', 200000)],
        },
      });
    });
    const result = await runCombo(transport, {
      saved_search_id: 'ss-1',
      group_id: 'g1',
      page_num: 1,
      page_size: 25,
      sort_field: 'property.ListPrice',
      sort_order: 'ASC',
    });
    expect(result.count).toBe(1);
  });

  it('throws a clear error when neither argument nor session context yields a saved_search_id', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerSavedWithListingsTools(server, client)
    );
    const res = await harness.callTool(
      'onehome_get_saved_search_with_listings',
      { group_id: 'g1' }
    );
    expect(res.isError).toBe(true);
  });

  it('throws a clear error when neither argument nor session context yields a group_id', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerSavedWithListingsTools(server, client)
    );
    const res = await harness.callTool(
      'onehome_get_saved_search_with_listings',
      { saved_search_id: 'ss-1' }
    );
    expect(res.isError).toBe(true);
  });

  it('surfaces saved-search filters/polygon on the saved_search block', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({
        savedSearch: {
          id: 'ss-1',
          name: 'Filtered',
          listingIds: ['A'],
          userQuery: [
            { fieldName: 'ListPrice', type: 'RANGE', values: ['0', '700000'] },
          ],
          polygon: [{ latitude: 35.4, longitude: -82.2 }],
        },
      })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 1 },
          listings: [sampleListing('A', 100000)],
        },
      })
    );
    const result = await runCombo(transport, {
      saved_search_id: 'ss-1',
      group_id: 'g1',
    });
    const savedSearch = result.saved_search as Record<string, unknown>;
    expect(savedSearch.filters).toEqual([
      { field: 'ListPrice', type: 'RANGE', values: ['0', '700000'] },
    ]);
    expect(savedSearch.polygon).toEqual([
      { latitude: 35.4, longitude: -82.2 },
    ]);
  });
});
