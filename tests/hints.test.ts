import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../src/client.js';
import { TOOL_REGISTRARS } from '../src/tools/register-all.js';
import { FakeTransport, ok, createTestHarness } from './helpers.js';
import type { RawListingDetail } from '../src/format.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off the served `tools/list` — what a host actually sees.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

async function served(transport = new FakeTransport()): Promise<Listed[]> {
  const client = new OneHomeClient({ transport });
  const h = await createTestHarness(async (server) => {
    for (const register of TOOL_REGISTRARS) await register(server, client);
  });
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  onehome_get_user: 'lookup',
  onehome_get_groups: 'lookup',
  onehome_get_session_context: 'lookup',
  onehome_get_saved_search: 'lookup',
  onehome_get_saved_search_with_listings: 'whats-new',
  onehome_search_properties: 'lookup',
  onehome_search_suggestions: 'lookup',
  onehome_get_property: 'lookup',
  onehome_get_property_photos: 'lookup',
  onehome_compare_properties: 'lookup',
  onehome_bulk_get: 'lookup',
  onehome_get_schools: 'lookup',
  onehome_get_walk_score: 'lookup',
  onehome_graphql: 'lookup',
  onehome_calculate_mortgage: 'lookup',
  onehome_calculate_affordability: 'lookup',
  onehome_get_by_address: 'lookup',
  onehome_resolve_addresses: 'lookup',
  onehome_set_auth: 'other',
  onehome_set_active_session: 'change',
};

describe('_meta.mint on tools/list', () => {
  it('names every served tool except the healthcheck, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => !n.endsWith('_healthcheck'));
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('every tool except the healthcheck carries domain home and its intent', async () => {
    for (const t of await served()) {
      if (t.name.endsWith('_healthcheck')) {
        expect(t._meta?.mint, t.name).toBeUndefined();
        continue;
      }
      const m = t._meta?.mint;
      expect(m, t.name).toBeDefined();
      expect(m!.domain, t.name).toBe('home');
      expect(m!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const m = t._meta?.mint;
      if (!m) continue;
      const props = t.inputSchema.properties ?? {};
      expect(Object.keys(m).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(m.domain);
      expect(INTENTS, t.name).toContain(m.intent);
      if ('canonical' in m) {
        expect(m.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(CANONICAL_INTENTS, t.name).toContain(m.intent);
      }
      if ('subject' in m) expect(props, t.name).toHaveProperty(m.subject as string);
      if ('when' in m) {
        const when = m.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start!);
        expect(props, t.name).toHaveProperty(when.end!);
      }
      if ('aliases' in m) {
        const aliases = m.aliases as string[];
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks at most one canonical read per intent: the saved search for whats-new', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['onehome_get_saved_search_with_listings', 'whats-new']]);
    for (const intent of CANONICAL_INTENTS) {
      expect(canonical.filter(([, i]) => i === intent).length).toBeLessThanOrEqual(1);
    }
  });

  it('the canonical read declares no subject or range (saved searches are not listable at start; it takes no dates)', async () => {
    const t = (await served()).find((x) => x.name === 'onehome_get_saved_search_with_listings')!;
    expect(t._meta?.mint).toEqual({
      domain: 'home',
      intent: 'whats-new',
      canonical: true,
      aliases: ['new listings', 'saved homes', 'house hunt', 'homes for sale', 'listings', 'real estate'],
    });
    expect(t.inputSchema.properties?.view?.enum).toEqual(['full', 'brief']);
  });
});

function listing(id: string, opts: { street: string; status?: string; change?: { type: string; at?: string } }): RawListingDetail {
  return {
    id,
    property: {
      ListPrice: 425000,
      City: 'Testville',
      StateOrProvince: 'NC',
      PostalCode: '28000',
      StreetNumber: '1',
      StreetName: opts.street,
      StreetSuffix: 'Way',
      ...(opts.status ? { StandardStatus: opts.status } : {}),
      ...(opts.change
        ? { MajorChangeType: opts.change.type, ...(opts.change.at ? { MajorChangeTimestamp: opts.change.at } : {}) }
        : {}),
    },
    customProperty: {},
    media: [],
  };
}

describe("the canonical read's brief view", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function brief(listings: RawListingDetail[]): Promise<string> {
    const transport = new FakeTransport();
    transport.on('GetSavedSearchBySearchId', () =>
      ok({ savedSearch: { id: 'ss-1', name: 'Synthetic search', listingIds: listings.map((l) => l.id) } }),
    );
    transport.on('GetSavedListings', () => ok({ listingsBySavedSearchId: { pageInfo: {}, listings } }));
    const client = new OneHomeClient({ transport });
    const h = await createTestHarness(async (server) => {
      for (const register of TOOL_REGISTRARS) await register(server, client);
    });
    close = () => h.close();
    const result = await h.callTool('onehome_get_saved_search_with_listings', {
      saved_search_id: 'ss-1',
      group_id: 'g-1',
      view: 'brief',
    });
    const first = result.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    return first.text;
  }

  it('answers one line per listing: title — ISO date | no date — status', async () => {
    const text = await brief([
      listing('A', { street: 'Alder', status: 'Active', change: { type: 'NewListing', at: '2026-10-30T14:05:00Z' } }),
      listing('B', { street: 'Birch', status: 'Pending', change: { type: 'PriceDecrease', at: '2026-10-28T09:00:00Z' } }),
      listing('C', { street: 'Cedar' }),
    ]);
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('1 Alder Way, Testville, NC 28000 · $425,000 — 2026-10-30 — Active, new listing');
    expect(lines[1]).toBe('1 Birch Way, Testville, NC 28000 · $425,000 — 2026-10-28 — Pending, price decrease');
    expect(lines[2]).toBe('1 Cedar Way, Testville, NC 28000 · $425,000 — no date — unknown');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(120);
      expect(line).toMatch(/^.+ — (\d{4}-\d{2}-\d{2}|no date) — .+$/);
    }
  });

  it('keeps a long title within 120 chars and the date and status intact', async () => {
    const text = await brief([
      listing('L', { street: 'A'.repeat(150), status: 'Active', change: { type: 'NewListing', at: '2026-11-01T00:00:00Z' } }),
    ]);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text.endsWith(' — 2026-11-01 — Active, new listing')).toBe(true);
  });

  it('answers no lines (not a note a host would count as an item) when the saved search is empty', async () => {
    expect(await brief([])).toBe('');
  });
});
