import { describe, it, expect, afterEach } from 'vitest';
import { BRIDGE_CONCURRENCY, FetchproxyTimeoutError } from '@fetchproxy/server';
import { OneHomeClient } from '../../src/client.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';
import type { RawListingDetail } from '../../src/format.js';

function sampleListing(
  id: string,
  price: number,
  opts: {
    withDescription?: boolean;
    lotSizeArea?: number;
    lotSizeUnits?: string;
  } = {}
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
      ...(opts.lotSizeArea !== undefined
        ? { LotSizeArea: opts.lotSizeArea, LotSizeUnits: opts.lotSizeUnits }
        : {}),
      ...(opts.withDescription
        ? { PublicRemarks: 'Lakefront beauty with private dock.' }
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

interface BulkRow {
  listing_id?: string;
  property?: Record<string, unknown>;
  error?: string;
}

interface BulkResult {
  count?: number;
  rows?: BulkRow[];
  group_id?: string;
}

async function runBulkGet(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<BulkResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) =>
    registerBulkGetTools(server, client)
  );
  const result = await harness.callTool('onehome_bulk_get', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

describe('onehome_bulk_get', () => {
  it('returns one row per listing_id, populated with the formatted property', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) => {
      const id = vars.listingId as string;
      return ok({ listingDetail: sampleListing(id, 100000) });
    });
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A', 'B', 'C'],
    });
    expect(result.count).toBe(3);
    expect(result.rows?.map((r) => r.listing_id)).toEqual(['A', 'B', 'C']);
    expect(result.rows?.[0]?.property?.listing_id).toBe('A');
    expect(result.rows?.[0]?.property?.list_price).toBe(100000);
    expect(result.rows?.[0]?.error).toBeUndefined();
  });

  it('captures per-row errors without failing the whole call', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) => {
      const id = vars.listingId as string;
      if (id === 'BAD') {
        return {
          data: { listingDetail: null } as unknown,
          status: 200,
          url: 'https://services.onehome.com/graphql',
        } as ReturnType<typeof ok>;
      }
      return ok({ listingDetail: sampleListing(id, 200000) });
    });
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A', 'BAD', 'C'],
    });
    expect(result.count).toBe(3);
    expect(result.rows?.[0]?.property?.listing_id).toBe('A');
    expect(result.rows?.[1]?.error).toBeDefined();
    expect(result.rows?.[1]?.property).toBeUndefined();
    expect(result.rows?.[1]?.listing_id).toBe('BAD');
    expect(result.rows?.[2]?.property?.listing_id).toBe('C');
  });

  it('flows lot_size_acres through per row: Square-Feet lot → acres, condo → null (issue #82)', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) => {
      const id = vars.listingId as string;
      // SFH carries a 45,738 sqft lot; condo carries no lot at all.
      const listing =
        id === 'SFH'
          ? sampleListing(id, 600000, {
              lotSizeArea: 45_738,
              lotSizeUnits: 'Square Feet',
            })
          : sampleListing(id, 300000);
      return ok({ listingDetail: listing });
    });
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['SFH', 'CONDO'],
    });
    const sfh = result.rows?.find((r) => r.listing_id === 'SFH')?.property;
    const condo = result.rows?.find((r) => r.listing_id === 'CONDO')?.property;
    expect(sfh?.lot_size).toEqual({ area: 45_738, units: 'Square Feet' });
    expect(sfh?.lot_size_acres).toBe(1.05);
    // Condo: no lot → acres null, never 0.
    expect(condo?.lot_size).toBeUndefined();
    expect(condo?.lot_size_acres).toBeNull();
    expect(condo?.lot_size_acres).not.toBe(0);
  });

  it('does not include a summary block (structured rows only)', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) =>
      ok({ listingDetail: sampleListing(vars.listingId as string, 100000) })
    );
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A'],
    });
    expect((result as Record<string, unknown>).summary).toBeUndefined();
  });

  it('omits description by default (include_description defaults false)', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) =>
      ok({
        listingDetail: sampleListing(vars.listingId as string, 100000, {
          withDescription: true,
        }),
      })
    );
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A'],
    });
    expect(result.rows?.[0]?.property?.description).toBeUndefined();
  });

  it('keeps description when include_description: true', async () => {
    const transport = new FakeTransport();
    transport.on('ListingById', (vars) =>
      ok({
        listingDetail: sampleListing(vars.listingId as string, 100000, {
          withDescription: true,
        }),
      })
    );
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A'],
      include_description: true,
    });
    expect(result.rows?.[0]?.property?.description).toBe(
      'Lakefront beauty with private dock.'
    );
  });

  it('defaults group_id from session context', async () => {
    const transport = new FakeTransport();
    transport.setStatus({
      authMode: 'magic_link',
      sessionContext: { groupId: 'g-ctx', savedSearchId: 'ss-ctx' },
    });
    transport.on('ListingById', (vars) => {
      expect(vars.groupId).toBe('g-ctx');
      return ok({
        listingDetail: sampleListing(vars.listingId as string, 100000),
      });
    });
    const result = await runBulkGet(transport, {
      listing_ids: ['A', 'B'],
    });
    expect(result.count).toBe(2);
  });

  it('rejects empty listing_ids[] at the schema layer', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, client)
    );
    const res = await harness.callTool('onehome_bulk_get', {
      group_id: 'g1',
      listing_ids: [],
    });
    expect(res.isError).toBe(true);
  });

  it('wraps bridge timeouts with the canonical "bridge timeout after retry" prefix and retries once', async () => {
    // Validates the @fetchproxy/server `retryOnceOnTimeout` + `classifyRowError`
    // wiring: per-row bridge timeouts surface distinctly from upstream
    // "no listing found"-style misses, which the cohort's bulk-summary
    // reporting relies on (fetchproxy #69).
    const transport = new FakeTransport();
    let attempts = 0;
    transport.on('ListingById', (vars) => {
      const id = vars.listingId as string;
      if (id === 'TIMEOUT') {
        attempts++;
        throw new FetchproxyTimeoutError({
          url: 'https://services.onehome.com/graphql',
          timeoutMs: 30000,
        });
      }
      return ok({ listingDetail: sampleListing(id, 100000) });
    });
    const result = await runBulkGet(transport, {
      group_id: 'g1',
      listing_ids: ['A', 'TIMEOUT', 'C'],
    });
    expect(attempts).toBe(2); // initial + one retry
    expect(result.rows?.[1]?.listing_id).toBe('TIMEOUT');
    expect(result.rows?.[1]?.error).toMatch(/^bridge timeout after retry: /);
    expect(result.rows?.[0]?.property?.listing_id).toBe('A');
    expect(result.rows?.[2]?.property?.listing_id).toBe('C');
  });

  it('caps concurrency to BRIDGE_CONCURRENCY (=6) to avoid swamping the bridge', async () => {
    const transport = new FakeTransport();
    let inflight = 0;
    let highWater = 0;
    transport.on('ListingById', async (vars) => {
      inflight++;
      if (inflight > highWater) highWater = inflight;
      await new Promise((r) => setImmediate(r));
      inflight--;
      return ok({ listingDetail: sampleListing(vars.listingId as string, 100000) });
    });
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    await runBulkGet(transport, { group_id: 'g1', listing_ids: ids });
    expect(highWater).toBeLessThanOrEqual(BRIDGE_CONCURRENCY);
  });

  it('rejects listing_ids[] longer than the documented cap', async () => {
    const transport = new FakeTransport();
    const client = new OneHomeClient({ transport });
    harness = await createTestHarness((server) =>
      registerBulkGetTools(server, client)
    );
    const tooMany = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    const res = await harness.callTool('onehome_bulk_get', {
      group_id: 'g1',
      listing_ids: tooMany,
    });
    expect(res.isError).toBe(true);
  });
});
