import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerBulkGetTools } from '../../src/tools/bulk-get.js';
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
