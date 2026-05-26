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
});
