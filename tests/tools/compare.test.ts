import { describe, it, expect } from 'vitest';
import { buildSummary, registerCompareTools } from '../../src/tools/compare.js';
import type { FormattedListing } from '../../src/format.js';
import { ok, makeClient, createTestHarness } from '../helpers.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const A: FormattedListing = {
  listing_id: 'A',
  url: 'https://portal.onehome.com/en-US/properties/A',
  address_full: '1 Lake Way, Lake Lure, NC, 28746',
  city: 'Lake Lure',
  state: 'NC',
  zip: '28746',
  list_price: 600000,
  beds: 3,
  baths: 2,
  living_area_sqft: 1500,
  price_per_sqft: 400,
  status: 'Active',
  lot_size: { area: 0.5, units: 'Acres' },
  lot_size_acres: 0.5,
  hoa_fee: { amount: 500, frequency: 'Annually' },
  tax_annual: 2000,
};

const B: FormattedListing = {
  listing_id: 'B',
  url: 'https://portal.onehome.com/en-US/properties/B',
  address_full: '2 Lake Way, Lake Lure, NC, 28746',
  city: 'Lake Lure',
  state: 'NC',
  zip: '28746',
  list_price: 800000,
  beds: 4,
  baths: 3,
  living_area_sqft: 2000,
  price_per_sqft: 400,
  status: 'Pending',
  lot_size_acres: null,
  tax_annual: 2500,
};

describe('buildSummary', () => {
  it('aligns one row per summary field across all rows', () => {
    const rows = [{ property: A }, { property: B }];
    const summary = buildSummary(rows);
    const byField = Object.fromEntries(summary.map((r) => [r.field, r.values]));
    expect(byField.list_price).toEqual([600000, 800000]);
    expect(byField.beds).toEqual([3, 4]);
    expect(byField.address_full).toEqual([
      '1 Lake Way, Lake Lure, NC, 28746',
      '2 Lake Way, Lake Lure, NC, 28746',
    ]);
    expect(byField.status).toEqual(['Active', 'Pending']);
  });

  it('includes lot_size (object) + lot_size_acres (number|null) in the summary (issue #82)', () => {
    const summary = buildSummary([{ property: A }, { property: B }]);
    const byField = Object.fromEntries(summary.map((r) => [r.field, r.values]));
    // Raw lot_size stays an object (per-row fidelity, issue #18); B has none.
    expect(byField.lot_size).toEqual([{ area: 0.5, units: 'Acres' }, null]);
    // Derived acres: A=0.5, condo B=null (never 0).
    expect(byField.lot_size_acres).toEqual([0.5, null]);
  });

  it('keeps hoa_fee as an object (not a JSON-encoded string) so it matches per-row shape (issue #18)', () => {
    const summary = buildSummary([{ property: A }]);
    const row = summary.find((r) => r.field === 'hoa_fee')!;
    expect(row.values[0]).toEqual({ amount: 500, frequency: 'Annually' });
  });

  it('emits null for missing per-row fields', () => {
    const summary = buildSummary([{ property: A }, { error: 'boom' }]);
    expect(summary.find((r) => r.field === 'list_price')!.values).toEqual([
      600000,
      null,
    ]);
  });
});

interface RawCompareResult {
  group_id?: string;
  target_count?: number;
  summary?: unknown;
  rows?: unknown[];
}

function parseToolResult(result: CallToolResult): RawCompareResult {
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('expected text block');
  return JSON.parse(block.text) as RawCompareResult;
}

const RAW_A = {
  id: 'A',
  property: {
    StreetNumber: '1',
    StreetName: 'Lake',
    StreetSuffix: 'Way',
    City: 'Lake Lure',
    StateOrProvince: 'NC',
    PostalCode: '28746',
    ListPrice: 600000,
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LotSizeArea: 45_738,
    LotSizeUnits: 'Square Feet',
    AssociationFee: 600,
    AssociationFeeFrequency: 'Annually',
    TaxAnnualAmount: 2000,
  },
} as const;
const RAW_B = {
  id: 'B',
  property: {
    StreetNumber: '2',
    StreetName: 'Lake',
    StreetSuffix: 'Way',
    City: 'Lake Lure',
    StateOrProvince: 'NC',
    PostalCode: '28746',
    ListPrice: 800000,
    BedroomsTotal: 4,
    BathroomsTotalInteger: 3,
    TaxAnnualAmount: 2500,
  },
} as const;

describe('onehome_compare_properties summary opt-in (issue #18)', () => {
  it('omits the summary field by default', async () => {
    const { client, transport } = makeClient();
    transport.setStatus({ sessionContext: { groupId: 'G' } });
    transport.on('ListingById', (vars) =>
      ok({
        listingDetail: vars.listingId === 'A' ? RAW_A : RAW_B,
      })
    );

    const harness = await createTestHarness((server) =>
      registerCompareTools(server, client)
    );
    try {
      const result = await harness.callTool('onehome_compare_properties', {
        targets: [{ listing_id: 'A' }, { listing_id: 'B' }],
      });
      const body = parseToolResult(result);
      expect('summary' in body).toBe(false);
      expect(Array.isArray(body.rows)).toBe(true);
      expect((body.rows as unknown[]).length).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it('includes the summary when include_summary: true, with hoa_fee as a plain object', async () => {
    const { client, transport } = makeClient();
    transport.setStatus({ sessionContext: { groupId: 'G' } });
    transport.on('ListingById', (vars) =>
      ok({
        listingDetail: vars.listingId === 'A' ? RAW_A : RAW_B,
      })
    );

    const harness = await createTestHarness((server) =>
      registerCompareTools(server, client)
    );
    try {
      const result = await harness.callTool('onehome_compare_properties', {
        targets: [{ listing_id: 'A' }, { listing_id: 'B' }],
        include_summary: true,
      });
      const body = parseToolResult(result);
      expect(Array.isArray(body.summary)).toBe(true);
      const summary = body.summary as Array<{ field: string; values: unknown[] }>;
      const hoaRow = summary.find((r) => r.field === 'hoa_fee')!;
      // Per issue #18, hoa_fee must be a real object — not a JSON-encoded string.
      expect(hoaRow.values[0]).toEqual({ amount: 600, frequency: 'Annually' });
      expect(hoaRow.values[1]).toBeNull();
      // #82: A's Square-Feet lot (45,738) → 1.05 acres; condo B → null.
      const acresRow = summary.find((r) => r.field === 'lot_size_acres')!;
      expect(acresRow.values[0]).toBe(1.05);
      expect(acresRow.values[1]).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
