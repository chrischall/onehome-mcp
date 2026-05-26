import { describe, it, expect } from 'vitest';
import { formatSavedSearch } from '../../src/tools/saved.js';

describe('formatSavedSearch', () => {
  it('flattens the upstream SavedSearch shape into snake_case keys', () => {
    const out = formatSavedSearch(
      {
        id: 'ss-1',
        name: 'Lake Lure < $700k',
        setType: 'AGENT_SAVED_SEARCH',
        isActive: true,
        resourceID: 'r-99',
        listingIds: ['A', 'B', 'C'],
        createdAt: '2026-01-02',
        updatedAt: '2026-03-04',
        userQuery: [
          { fieldName: 'ListPrice', type: 'RANGE', values: ['0', '700000'] },
          { fieldName: 'PropertyType', type: 'EQ', values: ['Residential'] },
        ],
        polygon: [{ latitude: 35.4, longitude: -82.2 }],
      },
      { include_listing_ids: true }
    );
    expect(out.saved_search_id).toBe('ss-1');
    expect(out.name).toBe('Lake Lure < $700k');
    expect(out.set_type).toBe('AGENT_SAVED_SEARCH');
    expect(out.is_active).toBe(true);
    expect(out.resource_id).toBe('r-99');
    expect(out.listing_count).toBe(3);
    expect(out.listing_ids).toEqual(['A', 'B', 'C']);
    expect(out.filters).toEqual([
      { field: 'ListPrice', type: 'RANGE', values: ['0', '700000'] },
      { field: 'PropertyType', type: 'EQ', values: ['Residential'] },
    ]);
    expect(out.polygon).toEqual([{ latitude: 35.4, longitude: -82.2 }]);
  });

  it('omits listing_ids when include_listing_ids is false (the default)', () => {
    const out = formatSavedSearch({
      id: 'ss-1',
      listingIds: ['A', 'B'],
    });
    expect(out.listing_count).toBe(2);
    expect(out.listing_ids).toBeUndefined();
  });

  it('omits absent fields entirely', () => {
    const out = formatSavedSearch({ id: 'x' });
    expect(out.saved_search_id).toBe('x');
    expect(out.set_type).toBeUndefined();
    expect(out.filters).toBeUndefined();
    expect(out.polygon).toBeUndefined();
    expect(out.listing_count).toBe(0);
  });
});
