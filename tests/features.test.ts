import { describe, it, expect } from 'vitest';
import {
  DEFAULT_COMMUNITIES,
  extractFeatures,
  loadCommunities,
} from '../src/features.js';

describe('extractFeatures', () => {
  const baseCommunities = DEFAULT_COMMUNITIES;

  it('returns all-null/false defaults when description is undefined', () => {
    const out = extractFeatures(undefined, baseCommunities);
    expect(out).toEqual({
      lake_front: false,
      hot_tub: false,
      basement: null,
      furnished: null,
      dock: null,
      community: null,
    });
  });

  it('returns defaults when description is the empty string', () => {
    const out = extractFeatures('', baseCommunities);
    expect(out.lake_front).toBe(false);
    expect(out.basement).toBeNull();
  });

  describe('lake_front', () => {
    it('matches lakefront (one word)', () => {
      expect(extractFeatures('Lakefront paradise', baseCommunities).lake_front).toBe(true);
    });
    it('matches lake front (two words)', () => {
      expect(extractFeatures('Has lake front views', baseCommunities).lake_front).toBe(true);
    });
    it('matches waterfront', () => {
      expect(extractFeatures('Waterfront cottage', baseCommunities).lake_front).toBe(true);
    });
    it('is case-insensitive', () => {
      expect(extractFeatures('LAKEFRONT', baseCommunities).lake_front).toBe(true);
    });
    it('does not match unrelated tokens (lakeside, oceanfront)', () => {
      // lakeside is not in the spec; oceanfront isn't either.
      expect(extractFeatures('lakeside dock', baseCommunities).lake_front).toBe(false);
      expect(extractFeatures('oceanfront property', baseCommunities).lake_front).toBe(false);
    });
  });

  describe('hot_tub', () => {
    it('matches hot tub (with space)', () => {
      expect(extractFeatures('Includes a hot tub', baseCommunities).hot_tub).toBe(true);
    });
    it('does not match hottub or jacuzzi', () => {
      expect(extractFeatures('Has a hottub', baseCommunities).hot_tub).toBe(false);
      expect(extractFeatures('jacuzzi on deck', baseCommunities).hot_tub).toBe(false);
    });
  });

  describe('basement', () => {
    it('returns "unfinished" — checked BEFORE "finished" (substring trap)', () => {
      // This is the regression test that pins the bug.
      expect(extractFeatures('Has an unfinished basement', baseCommunities).basement).toBe('unfinished');
    });
    it('returns "finished" when only "finished basement" appears', () => {
      expect(extractFeatures('Bonus room and finished basement', baseCommunities).basement).toBe('finished');
    });
    it('returns "partial" for partial-finish phrasings', () => {
      expect(extractFeatures('Partially finished basement with workshop', baseCommunities).basement).toBe('partial');
      expect(extractFeatures('Partial basement under one wing', baseCommunities).basement).toBe('partial');
    });
    it('returns "unknown" when basement is mentioned without a qualifier', () => {
      expect(extractFeatures('Basement storage included', baseCommunities).basement).toBe('unknown');
    });
    it('returns null when basement is not mentioned at all', () => {
      expect(extractFeatures('Crawl space with HVAC', baseCommunities).basement).toBeNull();
    });
    it('still returns "unfinished" when "finished" appears elsewhere in the text', () => {
      // The substring trap in reverse: "finished hardwood" should NOT make
      // "unfinished basement" misclassify.
      expect(
        extractFeatures(
          'Beautifully finished hardwood floors; the basement is unfinished.',
          baseCommunities
        ).basement
      ).toBe('unfinished');
    });
    it('does NOT misclassify "basement with finished oak shelving" as finished (false-positive pin)', () => {
      // The qualifier ("finished") is describing the shelving, not the
      // basement. Connector class is `is|was|are|were|—|–|,|;|:|(`;
      // free-floating prepositions like `with` / `near` should not match.
      // Result here is "unknown" because the basement IS mentioned but
      // no state-of-being qualifier is present.
      expect(
        extractFeatures(
          'Basement with finished oak shelving and built-in workbench.',
          baseCommunities
        ).basement
      ).toBe('unknown');
    });
    it('matches verb-attached state ("basement is finished")', () => {
      expect(
        extractFeatures('The basement is finished and walks out to the patio.', baseCommunities).basement
      ).toBe('finished');
    });
    it('matches colon / punctuated state ("basement: unfinished")', () => {
      expect(
        extractFeatures('Lower level — basement: unfinished, ready for buildout.', baseCommunities).basement
      ).toBe('unfinished');
    });
  });

  describe('furnished', () => {
    it('matches "fully furnished" → "fully"', () => {
      expect(extractFeatures('Sold fully furnished', baseCommunities).furnished).toBe('fully');
    });
    it('matches "sold furnished" → "fully"', () => {
      expect(extractFeatures('This one is sold furnished', baseCommunities).furnished).toBe('fully');
    });
    it('matches "turnkey" → "fully"', () => {
      expect(extractFeatures('Turnkey rental investment', baseCommunities).furnished).toBe('fully');
    });
    it('matches "almost furnished" → "partial"', () => {
      expect(extractFeatures('Almost furnished, see exclusions', baseCommunities).furnished).toBe('partial');
    });
    it('matches "furnished with exceptions" → "partial"', () => {
      expect(extractFeatures('Furnished with exceptions, list available', baseCommunities).furnished).toBe('partial');
    });
    it('does NOT misfire on bare "with exceptions" in non-furnishing context (false-positive pin)', () => {
      // Real estate descriptions routinely contain "with exceptions" in
      // title / survey / HOA / disclosure contexts. Don't return "partial"
      // unless the `furnished` token is present nearby.
      expect(
        extractFeatures('Sold with exceptions per title report; modern open floor plan.', baseCommunities).furnished
      ).toBeNull();
      expect(
        extractFeatures('HOA documents available with exceptions noted in section 3.', baseCommunities).furnished
      ).toBeNull();
    });
    it('matches "furnishings negotiable" → "negotiable"', () => {
      expect(extractFeatures('Furnishings negotiable', baseCommunities).furnished).toBe('negotiable');
      expect(extractFeatures('Furnishings are negotiable separately', baseCommunities).furnished).toBe('negotiable');
    });
    it('returns null when no furnishing phrase is present', () => {
      expect(extractFeatures('Modern finishes throughout', baseCommunities).furnished).toBeNull();
    });
  });

  describe('dock', () => {
    it('matches "private dock" → "private"', () => {
      expect(extractFeatures('Private dock on deep water', baseCommunities).dock).toBe('private');
    });
    it('matches "community dock" → "community"', () => {
      expect(extractFeatures('Community dock access', baseCommunities).dock).toBe('community');
    });
    it('matches "marina" → "marina"', () => {
      expect(extractFeatures('Marina slip included', baseCommunities).dock).toBe('marina');
    });
    it('does NOT match place-name "marina" (Marina Bay / del Rey / Dr) — guard (#1)', () => {
      // 0.4.0 marina place-name guard (ported from redfin-mcp): "marina"
      // is a common place / street name; the negative lookahead rejects the
      // usual address suffixes so addresses don't false-positive to 'marina'.
      expect(extractFeatures('Marina Bay condo with skyline views', baseCommunities).dock).toBeNull();
      expect(extractFeatures('Stunning home in Marina del Rey', baseCommunities).dock).toBeNull();
      expect(extractFeatures('123 Marina Dr, lakeside neighborhood', baseCommunities).dock).toBeNull();
    });
    it('still matches genuine water-access "marina" prose — guard (#1)', () => {
      expect(extractFeatures('Deep-water marina with boat access', baseCommunities).dock).toBe('marina');
      expect(extractFeatures('Steps from the marina.', baseCommunities).dock).toBe('marina');
    });
    it('matches "boat slip" → "boat_slip"', () => {
      expect(extractFeatures('Deeded boat slip', baseCommunities).dock).toBe('boat_slip');
    });
    it('prefers private over community when both phrases appear', () => {
      expect(
        extractFeatures('Private dock and the community dock nearby', baseCommunities).dock
      ).toBe('private');
    });
    it('returns null when no dock phrase is present', () => {
      expect(extractFeatures('Mountain views', baseCommunities).dock).toBeNull();
    });
  });

  describe('community', () => {
    it('matches a community name verbatim', () => {
      expect(
        extractFeatures('Located in Rumbling Bald', baseCommunities).community
      ).toBe('Rumbling Bald');
    });
    it('is case-insensitive', () => {
      expect(
        extractFeatures('RUMBLING BALD living at its best', baseCommunities).community
      ).toBe('Rumbling Bald');
    });
    it('tolerates trailing punctuation', () => {
      expect(
        extractFeatures(
          'Welcome to The Lodges at Eagles Nest! A premier mountain community.',
          baseCommunities
        ).community
      ).toBe('The Lodges at Eagles Nest');
    });
    it('returns null when no community name appears', () => {
      expect(extractFeatures('Lake view cottage', baseCommunities).community).toBeNull();
    });
    it('returns the first match when multiple are present', () => {
      const first = extractFeatures(
        'Near Riverbend at Lake Lure and Rumbling Bald',
        baseCommunities
      ).community;
      // First-by-document-position, not first-by-list-position.
      expect(first).toBe('Riverbend at Lake Lure');
    });
  });
});

describe('loadCommunities', () => {
  it('falls back to DEFAULT_COMMUNITIES when env var is unset', () => {
    delete process.env.ONEHOME_COMMUNITIES_FILE;
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
  });

  it('returns DEFAULT_COMMUNITIES (and warns to stderr) when the env path does not exist', () => {
    process.env.ONEHOME_COMMUNITIES_FILE = '/nonexistent/path/communities.json';
    expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    delete process.env.ONEHOME_COMMUNITIES_FILE;
  });

  it('reads a JSON array from the env-pointed path', async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'onehome-comm-'));
    const file = join(dir, 'communities.json');
    writeFileSync(file, JSON.stringify(['Test Mountain Club', 'Faux Estates']));
    process.env.ONEHOME_COMMUNITIES_FILE = file;
    try {
      expect(loadCommunities()).toEqual(['Test Mountain Club', 'Faux Estates']);
    } finally {
      unlinkSync(file);
      delete process.env.ONEHOME_COMMUNITIES_FILE;
    }
  });

  it('falls back to DEFAULT_COMMUNITIES when the env path holds malformed JSON', async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'onehome-comm-bad-json-'));
    const file = join(dir, 'communities.json');
    writeFileSync(file, '{this is not, valid JSON');
    process.env.ONEHOME_COMMUNITIES_FILE = file;
    try {
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    } finally {
      unlinkSync(file);
      delete process.env.ONEHOME_COMMUNITIES_FILE;
    }
  });

  it('falls back to DEFAULT_COMMUNITIES when the env path holds non-array JSON', async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'onehome-comm-non-array-'));
    const file = join(dir, 'communities.json');
    writeFileSync(file, JSON.stringify({ communities: ['Wrong Shape'] }));
    process.env.ONEHOME_COMMUNITIES_FILE = file;
    try {
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    } finally {
      unlinkSync(file);
      delete process.env.ONEHOME_COMMUNITIES_FILE;
    }
  });

  it('falls back to DEFAULT_COMMUNITIES when the env path holds an array with non-string entries', async () => {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'onehome-comm-mixed-'));
    const file = join(dir, 'communities.json');
    writeFileSync(file, JSON.stringify(['Valid Name', 42, null]));
    process.env.ONEHOME_COMMUNITIES_FILE = file;
    try {
      expect(loadCommunities()).toEqual(DEFAULT_COMMUNITIES);
    } finally {
      unlinkSync(file);
      delete process.env.ONEHOME_COMMUNITIES_FILE;
    }
  });
});
