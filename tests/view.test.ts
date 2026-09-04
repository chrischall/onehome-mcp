import { describe, it, expect } from 'vitest';
import { OH_VIEWS, viewArg, viewResponse } from '../src/view.js';

/** The serialised text of a tool result — always a single text block here. */
const textOf = (r: ReturnType<typeof viewResponse>): string =>
  (r.content[0] as { text: string }).text;

/**
 * The `view` vocabulary is only worth having if the DEFAULT is the cheap rung.
 * Four sibling repos shipped the projection as opt-in (`compact: false`), and
 * an efficiency a caller has to ask for is one they mostly do not — the caller
 * paying for it being the one least able to know it was on offer. So the first
 * thing pinned here is that omitting `view` strips.
 */
describe('viewResponse', () => {
  const listing = {
    listing_id: 'A',
    list_price: 600000,
    photo: 'https://media.onehome.com/A/1.jpg',
    thumbnailUrl: 'https://media.onehome.com/A/thumb.jpg',
  };

  it('strips media URLs when no view is given — compact is the DEFAULT rung', () => {
    const out = JSON.parse(textOf(viewResponse(undefined, listing)));
    expect(out).toEqual({ listing_id: 'A', list_price: 600000 });
  });

  it('strips media URLs on an explicit view: "compact"', () => {
    const out = JSON.parse(textOf(viewResponse('compact', listing)));
    expect(out.photo).toBeUndefined();
    expect(out.thumbnailUrl).toBeUndefined();
  });

  it('returns EVERYTHING on view: "full" — the escape hatch has to actually escape', () => {
    const out = JSON.parse(textOf(viewResponse('full', listing)));
    expect(out).toEqual(listing);
  });

  /**
   * Compact is SUBTRACTIVE — it names what to remove, never what to keep — so
   * a field this repo has never heard of cannot be lost by it. That is the
   * whole reason there is no invented field projection here.
   */
  it('passes an unanticipated field through compact untouched', () => {
    const out = JSON.parse(
      textOf(viewResponse('compact', { somethingNobodyAnticipated: 42 }))
    );
    expect(out.somethingNobodyAnticipated).toBe(42);
  });

  /**
   * The anchor at the START of a media key is a safety property, not an
   * oversight: a key that merely CONTAINS a media noun is a FACT about the
   * listing, and a caller filtering on it would otherwise watch it vanish and
   * read that as "not reported".
   */
  it('keeps a field that merely mentions a picture', () => {
    const out = JSON.parse(
      textOf(viewResponse('compact', { has_photos: false, photo_count: 12 }))
    );
    expect(out).toEqual({ has_photos: false, photo_count: 12 });
  });

  /**
   * Only FORMATTING whitespace goes. A listing's PublicRemarks carry
   * paragraph breaks, and a caller reading the description would see the
   * difference; the value must come back byte-identical.
   */
  it('leaves whitespace INSIDE a value byte-identical, and emits a single line', () => {
    const description = 'Line one.\n\n  Indented line two.\t Tabbed.';
    const text = textOf(viewResponse('compact', { description }));
    expect(JSON.parse(text).description).toBe(description);
    // One line: no pretty-printing. The `\n` above survives as the two-character
    // escape `\\n` in the serialised text, so a real newline would be an indent.
    expect(text.includes('\n')).toBe(false);
  });

  /** A rung this server does not honour must not error — it falls to compact. */
  it('falls back to compact for an unhonoured rung rather than throwing', () => {
    const out = JSON.parse(textOf(viewResponse('raw', listing)));
    expect(out).toEqual({ listing_id: 'A', list_price: 600000 });
  });
});

describe('viewArg', () => {
  it('offers exactly the rungs this server honours, and is optional', () => {
    expect([...OH_VIEWS]).toEqual(['compact', 'full']);
    const schema = viewArg();
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse('full')).toBe('full');
    expect(() => schema.parse('raw')).toThrow();
  });

  it('documents the rungs on the OPTIONAL wrapper, where a host reads it', () => {
    // `.describe()` applied to the inner enum leaves the wrapper's description
    // blank — a parameter documented to nobody.
    expect(viewArg().description).toContain('compact');
  });
});
