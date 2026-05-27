import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { formatSavedSearch, registerSavedTools } from '../../src/tools/saved.js';
import { FakeTransport, ok, createTestHarness } from '../helpers.js';

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

  it('omits listing_ids when include_listing_ids is explicitly false', () => {
    const out = formatSavedSearch(
      { id: 'ss-1', listingIds: ['A', 'B'] },
      { include_listing_ids: false }
    );
    expect(out.listing_count).toBe(2);
    expect(out.listing_ids).toBeUndefined();
  });

  it('omits listing_ids when opts are unspecified (pure formatter default stays off)', () => {
    // formatSavedSearch is a pure helper — its own default stays off so callers
    // (and snapshot tests) can opt in. The tool layer is what flips the
    // user-facing default to true; see the onehome_get_saved_search suite.
    const out = formatSavedSearch({ id: 'ss-1', listingIds: ['A', 'B'] });
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

interface SavedSearchResult {
  saved_search_id?: string;
  listing_count?: number;
  listing_ids?: string[];
}

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

async function runSavedTool(
  transport: FakeTransport,
  args: Record<string, unknown>
): Promise<SavedSearchResult> {
  const client = new OneHomeClient({ transport });
  harness = await createTestHarness((server) => registerSavedTools(server, client));
  const result = await harness.callTool('onehome_get_saved_search', args);
  const first = result.content[0]!;
  if (first.type !== 'text') throw new Error('expected text result');
  return JSON.parse(first.text);
}

describe('onehome_get_saved_search tool', () => {
  it('includes listing_ids by default (no include_listing_ids arg)', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', (variables) => {
      expect(variables.searchId).toBe('ss-1');
      return ok({
        savedSearch: {
          id: 'ss-1',
          name: 'Lake Lure',
          listingIds: ['A', 'B', 'C'],
        },
      });
    });
    const result = await runSavedTool(transport, { saved_search_id: 'ss-1' });
    expect(result.saved_search_id).toBe('ss-1');
    expect(result.listing_count).toBe(3);
    expect(result.listing_ids).toEqual(['A', 'B', 'C']);
  });

  it('honours include_listing_ids: false to opt out', async () => {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({
        savedSearch: {
          id: 'ss-1',
          listingIds: ['A', 'B'],
        },
      })
    );
    const result = await runSavedTool(transport, {
      saved_search_id: 'ss-1',
      include_listing_ids: false,
    });
    expect(result.listing_count).toBe(2);
    expect(result.listing_ids).toBeUndefined();
  });
});
