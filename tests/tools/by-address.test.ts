import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import {
  registerByAddressTools,
  buildAddressQuery,
} from '../../src/tools/by-address.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

interface ByAddressResult {
  resolved: boolean;
  url?: string;
  listing_id?: string;
  address?: string;
  error?: string;
  query?: string;
  matched_via?: 'suggestions' | 'search_fallback';
  matched_outside_saved_area?: boolean;
}

async function callBy(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<ByAddressResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) =>
    registerByAddressTools(server, client)
  );
  const result = await harness.callTool('onehome_get_by_address', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text');
  return JSON.parse(first.text);
}

describe('buildAddressQuery', () => {
  it('joins all provided parts with comma-space', () => {
    expect(
      buildAddressQuery({
        address: '126 Sleeping Bear Ln',
        city: 'Lake Lure',
        state: 'NC',
        zip: '28746',
      })
    ).toBe('126 Sleeping Bear Ln, Lake Lure, NC, 28746');
  });

  it('omits absent optional parts', () => {
    expect(buildAddressQuery({ address: '126 Main St' })).toBe('126 Main St');
  });
});

describe('onehome_get_by_address', () => {
  it('resolves an address to the top suggestion url + listing_id', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', (variables) => {
      expect(variables.browseParameter).toBe(
        '126 Sleeping Bear Ln, Lake Lure, NC, 28746'
      );
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
          },
        ],
      });
    });
    const result = await callBy(transport, {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('EYxAbC123');
    expect(result.url).toBe(
      'https://portal.onehome.com/en-US/properties/EYxAbC123'
    );
    expect(result.address).toContain('Sleeping Bear');
  });

  it('returns resolved:false when no suggestion matches', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    const result = await callBy(transport, { address: '999 Nowhere Rd' });
    expect(result.resolved).toBe(false);
    expect(result.error).toBe('no listing found');
    expect(result.query).toBe('999 Nowhere Rd');
  });

  it('returns resolved:false when the top suggestion has no id', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [{ city: 'Lake Lure', stateOrProvince: 'NC' }],
      })
    );
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.resolved).toBe(false);
  });

  it('falls back to listingId when id is absent on the top match', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          { listingId: 'FALLBACK_LID', city: 'X', stateOrProvince: 'NY' },
        ],
      })
    );
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.listing_id).toBe('FALLBACK_LID');
    expect(result.url).toBe(
      'https://portal.onehome.com/en-US/properties/FALLBACK_LID'
    );
  });

  it('forwards group_id from session context when not explicitly passed', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx' },
    });
    transport.on('ListingSuggestionsSearch', (variables) => {
      expect(variables.groupId).toBe('g-ctx');
      return ok({
        listingSuggestionsSearch: [{ id: 'X', city: 'Y', stateOrProvince: 'NC' }],
      });
    });
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.resolved).toBe(true);
  });

  it('explicit group_id overrides session context', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx' },
    });
    transport.on('ListingSuggestionsSearch', (variables) => {
      expect(variables.groupId).toBe('g-explicit');
      return ok({ listingSuggestionsSearch: [{ id: 'X' }] });
    });
    await callBy(transport, { address: '1 Main St', group_id: 'g-explicit' });
  });

  it('formats address with postalCity fallback when city is absent', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          {
            id: 'X',
            streetNumber: '1',
            streetName: 'Main',
            streetSuffix: 'St',
            postalCity: 'Brooklyn',
            stateOrProvince: 'NY',
            postalCode: '11201',
          },
        ],
      })
    );
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.address).toBe('1 Main St, Brooklyn, NY, 11201');
  });

  it('formats #unitNumber when present', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          {
            id: 'X',
            streetNumber: '155',
            streetName: 'Quail Cove',
            streetSuffix: 'Blvd',
            unitNumber: '1601',
            city: 'Lake Lure',
            stateOrProvince: 'NC',
            postalCode: '28746',
          },
        ],
      })
    );
    const result = await callBy(transport, { address: '155 Quail Cove Blvd' });
    expect(result.address).toBe(
      '155 Quail Cove Blvd #1601, Lake Lure, NC, 28746'
    );
  });

  it('falls back to the query string when the top match has no usable address parts', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [{ id: 'X' }] })
    );
    const result = await callBy(transport, { address: '1 Sparse Rd' });
    expect(result.address).toBe('1 Sparse Rd');
  });

  it('does not pick an entry where id is the empty string and listingId is also missing', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          { id: '' }, // skipped — empty string id
          { id: 'REAL', city: 'X', stateOrProvince: 'NY' },
        ],
      })
    );
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.listing_id).toBe('REAL');
  });

  it('surfaces matched_via: "suggestions" when the first rung hits', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', () =>
      ok({
        listingSuggestionsSearch: [
          { id: 'SUGG_HIT', city: 'Lake Lure', stateOrProvince: 'NC' },
        ],
      })
    );
    const result = await callBy(transport, { address: '1 Main St' });
    expect(result.resolved).toBe(true);
    expect(result.matched_via).toBe('suggestions');
  });
});

describe('onehome_get_by_address — search-fallback rung', () => {
  it('falls through to the saved-search pool when suggestions misses', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['EYx111', 'EYx222'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          pageInfo: { totalElements: 2, totalPages: 1, pageNumber: 0, pageSize: 2 },
          listings: [
            {
              id: 'EYx111',
              property: {
                StreetNumber: '212',
                StreetName: 'Ridgeway',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
                PostalCode: '28746',
              },
            },
            {
              id: 'EYx222',
              property: {
                StreetNumber: '999',
                StreetName: 'Other',
                StreetSuffix: 'St',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '212 Ridgeway Rd',
      city: 'Lake Lure',
      state: 'NC',
      zip: '28746',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('EYx111');
    expect(result.matched_via).toBe('search_fallback');
    expect(result.address).toContain('Ridgeway');
  });

  it('fuzzy-matches the right listing when the fallback pool has multiple hits', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['A', 'B', 'C'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              id: 'A',
              property: {
                StreetNumber: '99',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
            {
              id: 'B',
              property: {
                StreetNumber: '231',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
            {
              id: 'C',
              property: {
                StreetNumber: '1',
                StreetName: 'Highland',
                StreetSuffix: 'Heights',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('B');
    expect(result.matched_via).toBe('search_fallback');
  });

  it('falls through to raw listings when no savedSearchId on session', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetListings', () =>
      ok({
        listings: {
          listings: [
            {
              id: 'RAW_HIT',
              property: {
                StreetNumber: '181',
                StreetName: 'Highland',
                StreetSuffix: 'Heights',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '181 Highland Heights',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('RAW_HIT');
    expect(result.matched_via).toBe('search_fallback');
  });

  it('returns resolved:false when both rungs miss', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['A'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              id: 'A',
              property: {
                StreetNumber: '1',
                StreetName: 'Unrelated',
                StreetSuffix: 'St',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '999 Nowhere Rd',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(false);
    expect(result.error).toBe('no listing found');
  });

  it('skips the search-fallback rung when no groupId is available at all', async () => {
    const transport = new FakeTransport();
    // No session context, no explicit group_id => no fallback scope.
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    const result = await callBy(transport, { address: '1 Nowhere' });
    expect(result.resolved).toBe(false);
    expect(result.error).toBe('no listing found');
    // search-fallback ops should NOT have been called.
    const calls = transport.calls.map((c) => c.operationName);
    expect(calls).not.toContain('GetListings');
    expect(calls).not.toContain('GetSavedListings');
  });

  it('skips id-less hits during the fallback pool walk', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['NOID', 'GOOD'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              // id-less hit that would otherwise token-match — must be skipped
              // so we don't return a broken { listing_id: "" } result.
              property: {
                StreetNumber: '231',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
            {
              id: 'GOOD',
              property: {
                StreetNumber: '231',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('GOOD');
    expect(result.matched_via).toBe('search_fallback');
  });

  it('returns resolved:false when only id-less hits token-match', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['NOID'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              property: {
                StreetNumber: '231',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(false);
    expect(result.error).toBe('no listing found');
  });

  it('flags matched_outside_saved_area when fallback hit lacks the input city', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', () =>
      ok({ listingSuggestionsSearch: [] })
    );
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['A'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              id: 'A',
              property: {
                StreetNumber: '231',
                StreetName: 'Bluebird',
                StreetSuffix: 'Rd',
                City: 'Asheville', // remapped away from caller's "Lake Lure"
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callBy(transport, {
      address: '231 Bluebird Rd',
      city: 'Lake Lure',
      state: 'NC',
    });
    expect(result.resolved).toBe(true);
    expect(result.listing_id).toBe('A');
    expect(result.matched_via).toBe('search_fallback');
    expect(result.matched_outside_saved_area).toBe(true);
  });
});
