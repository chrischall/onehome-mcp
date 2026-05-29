import { describe, it, expect } from 'vitest';
import {
  buildGetOneHomeUser,
  buildGetSavedSearchBySearchId,
  buildGetListings,
  buildGetSavedListings,
  buildListingSuggestionsSearch,
  buildListingById,
  buildMediaListingById,
} from '../src/queries.js';

describe('query builders', () => {
  it('GetOneHomeUser has no required variables and pulls groups inline', () => {
    const req = buildGetOneHomeUser();
    expect(req.operationName).toBe('GetOneHomeUser');
    expect(req.query).toContain('query GetOneHomeUser');
    expect(req.query).toContain('groups {');
    expect(req.query).toContain('agent {');
  });

  it('GetSavedSearchBySearchId passes the search id', () => {
    const req = buildGetSavedSearchBySearchId('ss-1');
    expect(req.variables?.searchId).toBe('ss-1');
    expect(req.query).toContain('savedSearch(id: $searchId)');
  });

  it('GetListings sends BrowseParameter with pageInput { pageNum, size }', () => {
    const req = buildGetListings({ groupId: 'g1' });
    expect(req.variables?.groupId).toBe('g1');
    expect(req.variables?.browseParameter).toEqual({
      pageInput: { pageNum: 0, size: 50 },
    });
    expect(req.variables?.includeDislikes).toBe(false);
  });

  it('GetListings honors caller overrides', () => {
    const req = buildGetListings({
      groupId: 'g1',
      browseParameter: {
        sort: { name: 'property.ListPrice', order: 'ASC' },
        pageInput: { pageNum: 2, size: 25 },
      },
      includeDislikes: true,
    });
    expect(req.variables?.browseParameter).toEqual({
      sort: { name: 'property.ListPrice', order: 'ASC' },
      pageInput: { pageNum: 2, size: 25 },
    });
    expect(req.variables?.includeDislikes).toBe(true);
  });

  it('GetSavedListings always sends suppressEvent=true + default Newest sort', () => {
    const req = buildGetSavedListings({
      groupId: 'g1',
      savedSearchId: 'ss-1',
      listingIds: ['A', 'B'],
    });
    expect(req.variables?.suppressEvent).toBe(true);
    expect(req.variables?.listingIds).toEqual(['A', 'B']);
    expect(req.variables?.sort).toEqual({
      name: 'property.MajorChangeTimestamp',
      order: 'DESC',
    });
    expect(req.variables?.pageInput).toEqual({ pageNum: 0, size: 50 });
  });

  it('ListingSuggestionsSearch passes the user query through', () => {
    const req = buildListingSuggestionsSearch({ browseParameter: '4276702' });
    expect(req.variables?.browseParameter).toBe('4276702');
    expect(req.variables?.groupId).toBeNull();
  });

  it('ListingById requires listing + group ids', () => {
    const req = buildListingById({ listingId: 'L', groupId: 'G' });
    expect(req.variables?.listingId).toBe('L');
    expect(req.variables?.groupId).toBe('G');
    expect(req.variables?.suppressEvent).toBe(true);
  });

  // Issue #25 restored (regression from #56): in OneHome's live schema
  // `UnparsedAddress` is a field on the parent listing type
  // (`listingDetail` level) — a SIBLING of `customProperty`, alongside the
  // RESO address fields — NOT a field of `CustomProperty`. PR #56 correctly
  // removed it from the `customProperty {}` block (where it was undefined);
  // it must be re-added at the listingDetail level so `address_alternates`
  // is restored. Pin that it is selected as a sibling of `customProperty`
  // and is NOT nested inside the `customProperty {}` block.
  it('ListingById selects UnparsedAddress at the listingDetail level, sibling of customProperty', () => {
    const req = buildListingById({ listingId: 'L', groupId: 'G' });
    expect(req.query).toContain('UnparsedAddress');
    expect(req.query).toContain('customProperty {');
    expect(req.query).toContain('ListingKey');
    expect(req.query).toContain('FIPSCode');
    // It must NOT be nested inside the customProperty selection.
    const cpBlock = req.query.slice(
      req.query.indexOf('customProperty {'),
      req.query.indexOf('}', req.query.indexOf('customProperty {'))
    );
    expect(cpBlock).not.toContain('UnparsedAddress');
  });

  it('GetListings (listingCard fragment) selects UnparsedAddress as a sibling of customProperty', () => {
    const req = buildGetListings({ groupId: 'g1' });
    expect(req.query).toContain('UnparsedAddress');
    expect(req.query).toContain('customProperty {');
    expect(req.query).toContain('ListingKey');
    expect(req.query).toContain('FIPSCode');
    const cpBlock = req.query.slice(
      req.query.indexOf('customProperty {'),
      req.query.indexOf('}', req.query.indexOf('customProperty {'))
    );
    expect(cpBlock).not.toContain('UnparsedAddress');
  });

  it('MediaListingById queries the listingDetail media field', () => {
    const req = buildMediaListingById({ listingId: 'L', groupId: 'G' });
    expect(req.query).toContain('media {');
    expect(req.query).toContain('Image {');
  });

  it('listingCard fragment selects all three Image variants (Thumbnail/Medium/Large)', () => {
    // pickPrimaryPhoto prefers Image.Large.mediaUrl — but the card
    // fragment only selected Thumbnail + Medium, so that read was dead on
    // every search/listing-card path. Select Large too so the primary
    // photo is the full-res CDN URL when present.
    const req = buildGetListings({ groupId: 'g1' });
    const mediaBlock = req.query.slice(req.query.indexOf('media {'));
    expect(mediaBlock).toContain('Thumbnail {');
    expect(mediaBlock).toContain('Medium {');
    expect(mediaBlock).toContain('Large {');
  });
});
