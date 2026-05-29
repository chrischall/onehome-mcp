import { describe, it, expect, afterEach } from 'vitest';
import { FetchproxyTimeoutError } from '@fetchproxy/server';
import { OneHomeClient } from '../../src/client.js';
import { registerResolveAddressesTools } from '../../src/tools/resolve-addresses.js';
import { registerByAddressTools } from '../../src/tools/by-address.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

interface ResolveRow {
  resolved: boolean;
  url?: string;
  listing_id?: string;
  address?: string;
  error?: string;
  query?: string;
  matched_via?: 'suggestions' | 'search_fallback';
  matched_outside_saved_area?: boolean;
}

interface ResolveResult {
  count?: number;
  resolved?: number;
  unresolved?: number;
  rows?: ResolveRow[];
}

async function callResolve(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<ResolveResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) =>
    registerResolveAddressesTools(server, client)
  );
  const result = await harness.callTool('onehome_resolve_addresses', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

async function callByAddress(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<ResolveRow> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) =>
    registerByAddressTools(server, client)
  );
  const result = await harness.callTool('onehome_get_by_address', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

describe('onehome_resolve_addresses', () => {
  it('returns one row per input address with the resolved listing', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', (vars) => {
      const q = vars.browseParameter as string;
      if (q.startsWith('126 Sleeping Bear')) {
        return ok({
          listingSuggestionsSearch: [
            {
              id: 'EYxAAA',
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
      }
      if (q.startsWith('155 Quail Cove')) {
        return ok({
          listingSuggestionsSearch: [
            {
              id: 'EYxBBB',
              streetNumber: '155',
              streetName: 'Quail Cove',
              streetSuffix: 'Blvd',
              city: 'Lake Lure',
              stateOrProvince: 'NC',
              postalCode: '28746',
            },
          ],
        });
      }
      return ok({ listingSuggestionsSearch: [] });
    });
    const result = await callResolve(transport, {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        { address: '155 Quail Cove Blvd', city: 'Lake Lure', state: 'NC' },
        { address: '999 Nowhere Rd' },
      ],
    });
    expect(result.count).toBe(3);
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toBe(1);
    expect(result.rows?.[0]?.resolved).toBe(true);
    expect(result.rows?.[0]?.listing_id).toBe('EYxAAA');
    expect(result.rows?.[1]?.listing_id).toBe('EYxBBB');
    expect(result.rows?.[2]?.resolved).toBe(false);
    expect(result.rows?.[2]?.error).toBe('no listing found');
  });

  it('captures per-row errors without aborting the batch', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', (vars) => {
      const q = vars.browseParameter as string;
      if (q.includes('boom')) {
        throw new Error('upstream boom');
      }
      return ok({
        listingSuggestionsSearch: [
          { id: 'OK', city: 'X', stateOrProvince: 'NY' },
        ],
      });
    });
    const result = await callResolve(transport, {
      addresses: [
        { address: '1 Good St' },
        { address: '2 boom Ave' },
        { address: '3 Good Rd' },
      ],
    });
    expect(result.count).toBe(3);
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toBe(1);
    expect(result.rows?.[1]?.resolved).toBe(false);
    expect(result.rows?.[1]?.error).toContain('boom');
  });

  it('preserves input order', async () => {
    const transport = new FakeTransport();
    transport.on('ListingSuggestionsSearch', (vars) => {
      const q = vars.browseParameter as string;
      return ok({
        listingSuggestionsSearch: [
          { id: `id-${q}`, city: 'X', stateOrProvince: 'NY' },
        ],
      });
    });
    const result = await callResolve(transport, {
      addresses: [
        { address: '1 First Ave' },
        { address: '2 Second Ave' },
        { address: '3 Third Ave' },
      ],
    });
    expect(result.rows?.[0]?.listing_id).toBe('id-1 First Ave');
    expect(result.rows?.[1]?.listing_id).toBe('id-2 Second Ave');
    expect(result.rows?.[2]?.listing_id).toBe('id-3 Third Ave');
  });

  it('forwards group_id from session context when not explicit', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx' },
    });
    transport.on('ListingSuggestionsSearch', (vars) => {
      expect(vars.groupId).toBe('g-ctx');
      return ok({
        listingSuggestionsSearch: [{ id: 'X' }],
      });
    });
    const result = await callResolve(transport, {
      addresses: [{ address: '1 Main St' }],
    });
    expect(result.rows?.[0]?.resolved).toBe(true);
  });

  it('explicit top-level group_id overrides session context', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx' },
    });
    transport.on('ListingSuggestionsSearch', (vars) => {
      expect(vars.groupId).toBe('g-explicit');
      return ok({ listingSuggestionsSearch: [{ id: 'X' }] });
    });
    await callResolve(transport, {
      addresses: [{ address: '1 Main St' }],
      group_id: 'g-explicit',
    });
  });

  it('parity: batch row matches single get_by_address for the same input', async () => {
    // Same fake handler for both call paths.
    const handler = (vars: Record<string, unknown>) => {
      const q = vars.browseParameter as string;
      if (q.startsWith('126 Sleeping Bear')) {
        return ok({
          listingSuggestionsSearch: [
            {
              id: 'EYxAAA',
              city: 'Lake Lure',
              stateOrProvince: 'NC',
              postalCode: '28746',
              streetNumber: '126',
              streetName: 'Sleeping Bear',
              streetSuffix: 'Lane',
            },
          ],
        });
      }
      return ok({ listingSuggestionsSearch: [] });
    };

    // Single
    const singleTransport = new FakeTransport();
    singleTransport.on('ListingSuggestionsSearch', handler);
    const singleHit = await callByAddress(singleTransport, {
      address: '126 Sleeping Bear Ln',
      city: 'Lake Lure',
      state: 'NC',
    });
    const singleMiss = await callByAddress(singleTransport, {
      address: '999 Nowhere Rd',
    });

    // Batch — re-create transport, same handler.
    const batchTransport = new FakeTransport();
    batchTransport.on('ListingSuggestionsSearch', handler);
    const batch = await callResolve(batchTransport, {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        { address: '999 Nowhere Rd' },
      ],
    });

    expect(batch.rows?.[0]?.resolved).toBe(singleHit.resolved);
    expect(batch.rows?.[0]?.listing_id).toBe(singleHit.listing_id);
    expect(batch.rows?.[0]?.url).toBe(singleHit.url);
    expect(batch.rows?.[0]?.address).toBe(singleHit.address);

    expect(batch.rows?.[1]?.resolved).toBe(singleMiss.resolved);
    expect(batch.rows?.[1]?.error).toBe(singleMiss.error);
    expect(batch.rows?.[1]?.query).toBe(singleMiss.query);
  });

  it('bulk inherits the search-fallback rung when suggestions misses', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-1' },
    });
    transport.on('ListingSuggestionsSearch', (vars) => {
      const q = vars.browseParameter as string;
      if (q.startsWith('126 Sleeping Bear')) {
        return ok({
          listingSuggestionsSearch: [
            { id: 'SUGG_HIT', city: 'Lake Lure', stateOrProvince: 'NC' },
          ],
        });
      }
      return ok({ listingSuggestionsSearch: [] });
    });
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', listingIds: ['FB'] } })
    );
    transport.on('GetSavedListings', () =>
      ok({
        listingsBySavedSearchId: {
          listings: [
            {
              id: 'FB',
              property: {
                StreetNumber: '212',
                StreetName: 'Ridgeway',
                StreetSuffix: 'Rd',
                City: 'Lake Lure',
                StateOrProvince: 'NC',
              },
            },
          ],
        },
      })
    );
    const result = await callResolve(transport, {
      addresses: [
        { address: '126 Sleeping Bear Ln', city: 'Lake Lure', state: 'NC' },
        { address: '212 Ridgeway Rd', city: 'Lake Lure', state: 'NC' },
      ],
    });
    expect(result.resolved).toBe(2);
    expect(result.rows?.[0]?.matched_via).toBe('suggestions');
    expect(result.rows?.[1]?.matched_via).toBe('search_fallback');
    expect(result.rows?.[1]?.listing_id).toBe('FB');
  });

  it('fetches the saved-search pool once for a multi-address same-pool batch', async () => {
    // Perf (P1): a batch where every row misses suggestions and falls to
    // the search-fallback rung must pull the identical saved-search pool
    // ONCE, not once per address. Memoized on (groupId, savedSearchId).
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
                StreetNumber: '212',
                StreetName: 'Ridgeway',
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
                StreetNumber: '99',
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
    const result = await callResolve(transport, {
      addresses: [
        { address: '212 Ridgeway Rd', city: 'Lake Lure', state: 'NC' },
        { address: '231 Bluebird Rd', city: 'Lake Lure', state: 'NC' },
        { address: '99 Highland Heights', city: 'Lake Lure', state: 'NC' },
      ],
    });
    expect(result.resolved).toBe(3);
    expect(result.rows?.[0]?.listing_id).toBe('A');
    expect(result.rows?.[1]?.listing_id).toBe('B');
    expect(result.rows?.[2]?.listing_id).toBe('C');
    // The expensive pool fetches happen exactly once for the whole batch.
    const savedSearchCalls = transport.calls.filter(
      (c) => c.operationName === 'GetSavedSearchBySearchId'
    );
    const savedListingsCalls = transport.calls.filter(
      (c) => c.operationName === 'GetSavedListings'
    );
    expect(savedSearchCalls.length).toBe(1);
    expect(savedListingsCalls.length).toBe(1);
  });

  it('wraps bridge timeouts with the canonical "bridge timeout after retry" prefix and retries once', async () => {
    // Validates the @fetchproxy/server `retryOnceOnTimeout` +
    // `classifyRowError` wiring: bridge timeouts surface distinctly
    // from upstream "no listing found" misses (fetchproxy #69).
    const transport = new FakeTransport();
    let attempts = 0;
    transport.on('ListingSuggestionsSearch', (vars) => {
      const q = vars.browseParameter as string;
      if (q.includes('timeout')) {
        attempts++;
        throw new FetchproxyTimeoutError({
          url: 'https://services.onehome.com/graphql',
          timeoutMs: 30000,
        });
      }
      return ok({
        listingSuggestionsSearch: [
          { id: 'OK', city: 'X', stateOrProvince: 'NY' },
        ],
      });
    });
    const result = await callResolve(transport, {
      addresses: [
        { address: '1 Good St' },
        { address: '2 timeout Ave' },
        { address: '3 Good Rd' },
      ],
    });
    expect(attempts).toBe(2); // initial + one retry on the timing-out row
    expect(result.rows?.[1]?.resolved).toBe(false);
    expect(result.rows?.[1]?.error).toMatch(/^bridge timeout after retry: /);
    expect(result.rows?.[1]?.query).toBeDefined();
    expect(result.rows?.[0]?.resolved).toBe(true);
    expect(result.rows?.[2]?.resolved).toBe(true);
  });

  it('caps concurrency to avoid swamping the upstream', async () => {
    // 20 inputs but at most 6 in flight at once. Track concurrency by
    // resolving each handler asynchronously and watching the high-water
    // mark.
    const transport = new FakeTransport();
    let inflight = 0;
    let highWater = 0;
    transport.on('ListingSuggestionsSearch', async (vars) => {
      inflight++;
      if (inflight > highWater) highWater = inflight;
      // Yield so other tasks can stack up if there's no cap.
      await new Promise((r) => setImmediate(r));
      inflight--;
      return ok({
        listingSuggestionsSearch: [
          { id: `id-${vars.browseParameter as string}`, city: 'X', stateOrProvince: 'NY' },
        ],
      });
    });
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      address: `${i + 1} Test St`,
    }));
    await callResolve(transport, { addresses: inputs });
    expect(highWater).toBeLessThanOrEqual(6);
  });
});
