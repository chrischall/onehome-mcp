import { describe, it, expect } from 'vitest';
import { buildSummary } from '../../src/tools/compare.js';
import type { FormattedListing } from '../../src/format.js';

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

  it('stringifies object fields (hoa_fee) so the table stays flat', () => {
    const summary = buildSummary([{ property: A }]);
    const row = summary.find((r) => r.field === 'hoa_fee')!;
    expect(typeof row.values[0]).toBe('string');
    expect(row.values[0]).toContain('Annually');
  });

  it('emits null for missing per-row fields', () => {
    const summary = buildSummary([{ property: A }, { error: 'boom' }]);
    expect(summary.find((r) => r.field === 'list_price')!.values).toEqual([
      600000,
      null,
    ]);
  });
});
