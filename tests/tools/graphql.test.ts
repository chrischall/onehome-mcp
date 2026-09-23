import { describe, it, expect, afterEach } from 'vitest';
import { OneHomeClient } from '../../src/client.js';
import { registerGraphqlTool } from '../../src/tools/graphql.js';
import { FakeTransport, createTestHarness } from '../helpers.js';

let harness: Awaited<ReturnType<typeof createTestHarness>> | undefined;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

/**
 * `onehome_graphql` returns the upstream envelope VERBATIM, which makes it the
 * one tool in this server whose response really does carry OneHome's own media
 * URLs — and so the one place compact strips something real end-to-end rather
 * than agreeing with full.
 */
describe('onehome_graphql — view', () => {
  const media = {
    listing: {
      id: 'A',
      list_price: 600000,
      photo: 'https://media.onehome.com/A/1.jpg',
      thumbnailUrl: 'https://media.onehome.com/A/thumb.jpg',
    },
  };

  async function callGraphql(
    t: FakeTransport,
    args: Record<string, unknown> = {}
  ): Promise<string> {
    const client = new OneHomeClient({ transport: t });
    harness = await createTestHarness((server) => registerGraphqlTool(server, client));
    const r = await harness.callTool('onehome_graphql', {
      operation_name: 'ListingById',
      query: 'query ListingById { listing { id } }',
      ...args,
    });
    const first = r.content[0]!;
    if (first.type !== 'text') throw new Error('expected text');
    return first.text;
  }

  const envelope = () => ({
    data: media,
    status: 200,
    url: 'https://services.onehome.com/graphql',
  });

  it('strips the media URLs by DEFAULT — compact is what a caller gets unasked', async () => {
    const t = new FakeTransport().on('ListingById', envelope);
    const parsed = JSON.parse(await callGraphql(t));
    expect(parsed.data.listing.photo).toBeUndefined();
    expect(parsed.data.listing.thumbnailUrl).toBeUndefined();
    // Subtractive, so everything that is not a picture is still here — including
    // the envelope fields a caller reaches for when a document is rejected.
    expect(parsed.data.listing.list_price).toBe(600000);
    expect(parsed.status).toBe(200);
  });

  it('returns the media URLs on view: "full"', async () => {
    const t = new FakeTransport().on('ListingById', envelope);
    const parsed = JSON.parse(await callGraphql(t, { view: 'full' }));
    expect(parsed.data.listing.photo).toBe('https://media.onehome.com/A/1.jpg');
    expect(parsed.data.listing.thumbnailUrl).toBe('https://media.onehome.com/A/thumb.jpg');
  });

  it('emits a single line — no pretty-printing on either rung', async () => {
    for (const args of [{}, { view: 'full' }]) {
      const t = new FakeTransport().on('ListingById', envelope);
      expect((await callGraphql(t, args)).includes('\n')).toBe(false);
      await harness?.close();
      harness = undefined;
    }
  });

  // `view` is a RESPONSE-shape argument; OneHome has never heard of it. This
  // handler forwards a caller-supplied document and variables straight
  // upstream, which is exactly the shape in which two sibling repos leaked
  // `view=compact` to a live API.
  it('never forwards `view` into the GraphQL request', async () => {
    const t = new FakeTransport().on('ListingById', envelope);
    await callGraphql(t, { view: 'full', variables: { id: 'A' } });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.variables).toEqual({ id: 'A' });
  });
});

// chrischall/fleet-audit#193: the tool is annotated readOnlyHint:true
// (clients auto-approve on it), so it must refuse write operations
// rather than post them with the user's bearer.
describe('onehome_graphql — read-only enforcement', () => {
  async function call(query: string) {
    const t = new FakeTransport();
    t.on('Op', () => ({ data: { ok: true }, status: 200, url: 'u' }));
    const client = new OneHomeClient({ transport: t });
    harness = await createTestHarness((server) => registerGraphqlTool(server, client));
    const r = await harness.callTool('onehome_graphql', { operation_name: 'Op', query });
    const first = r.content[0]!;
    const text = first.type === 'text' ? first.text : '';
    return { isError: r.isError === true, text, calls: t.calls.length };
  }

  it.each([
    ['a mutation', 'mutation Op { dislikeListing(id: "A") }'],
    ['a subscription', 'subscription Op { listingChanged { id } }'],
    ['a mutation after a comment', '# harmless\nmutation Op { x }'],
    ['a mutation in a multi-operation document', 'query Q { a } mutation Op { b }'],
    ['an anonymous mutation', 'mutation { b }'],
    ['a mutation after a fragment', 'fragment F on T { id } mutation Op { x { ...F } }'],
    [
      'a mutation after a block string with an escaped triple quote',
      'query Q { a(s: """ \\""" """) } mutation Op { b }',
    ],
  ])('rejects %s without sending it upstream', async (_label, query) => {
    const r = await call(query);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read-only/i);
    expect(r.calls).toBe(0);
  });

  it.each([
    ['a named query', 'query Op { a }'],
    ['a shorthand query', '{ a }'],
    ['a query whose string argument says mutation', 'query Op { search(q: "mutation { x }") { id } }'],
    ['a query with a # mutation comment', 'query Op {\n  # mutation Op { x }\n  a\n}'],
    ['a query with a block string', 'query Op { s(q: """\nmutation X { y }\n""") }'],
    ['a query with a $mutation variable', 'query Op($mutation: String) { a(b: $mutation) }'],
    ['a query plus a fragment', 'query Op { ...F } fragment F on T { id }'],
  ])('allows %s', async (_label, query) => {
    const r = await call(query);
    expect(r.isError).toBe(false);
    expect(r.calls).toBe(1);
  });
});
