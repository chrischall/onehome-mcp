import { describe, it, expect } from 'vitest';
import { formatListing, pickPrimaryPhoto, buildPropertyUrl } from '../src/format.js';
import type { RawListingDetail } from '../src/format.js';

const SAMPLE: RawListingDetail = {
  id: 'EY8xZsLake126',
  property: {
    StreetNumber: '126',
    StreetName: 'Sleeping Bear',
    StreetSuffix: 'Lane',
    City: 'Lake Lure',
    StateOrProvince: 'NC',
    PostalCode: '28746',
    ListPrice: 629000,
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 1560,
    LivingAreaTotal: 1560,
    PropertyType: 'Residential',
    PropertySubType: 'Single Family Residence',
    Latitude: 35.42,
    Longitude: -82.2,
    StandardStatus: 'Active',
    MajorChangeType: 'PriceDecrease',
    MajorChangeTimestamp: '2026-05-12T10:00:00Z',
    LotSizeArea: 0.5,
    LotSizeUnits: 'Acres',
    YearBuilt: 1995,
    AssociationFee: 800,
    AssociationFeeFrequency: 'Annually',
    TaxAnnualAmount: 2100,
    TaxYear: 2025,
    PublicRemarks: 'Lakefront cabin with private dock.',
    VirtualTourURLUnbranded: 'https://tour.example/cab1',
    ListingId: '4276702',
  },
  customProperty: { ListingKey: 'CANOPY:4276702', ListingId: '4276702' },
  media: [
    {
      Order: 1,
      Image: {
        Thumbnail: { mediaUrl: 'https://cdn/x/th.jpg', width: 320, height: 240 },
        Medium: { mediaUrl: 'https://cdn/x/m.jpg', width: 800, height: 600 },
        Large: { mediaUrl: 'https://cdn/x/l.jpg', width: 1600, height: 1200 },
      },
    },
    {
      Order: 0,
      Image: {
        Thumbnail: { mediaUrl: 'https://cdn/y/th.jpg' },
        Medium: { mediaUrl: 'https://cdn/y/m.jpg' },
      },
    },
  ],
};

describe('formatListing', () => {
  it('builds a flat address from street + city + state + zip', () => {
    const out = formatListing(SAMPLE.id!, SAMPLE);
    expect(out.address_full).toBe('126 Sleeping Bear Lane, Lake Lure, NC 28746');
    expect(out.street).toBe('126 Sleeping Bear Lane');
    expect(out.city).toBe('Lake Lure');
    expect(out.state).toBe('NC');
    expect(out.zip).toBe('28746');
  });

  it('flattens price + property facts', () => {
    const out = formatListing(SAMPLE.id!, SAMPLE);
    expect(out.list_price).toBe(629000);
    expect(out.beds).toBe(3);
    expect(out.baths).toBe(2);
    expect(out.living_area_sqft).toBe(1560);
    expect(out.price_per_sqft).toBeCloseTo(403.21, 1);
    expect(out.year_built).toBe(1995);
    expect(out.status).toBe('Active');
    expect(out.lot_size).toEqual({ area: 0.5, units: 'Acres' });
    expect(out.major_change).toEqual({
      type: 'PriceDecrease',
      at: '2026-05-12T10:00:00Z',
    });
    expect(out.hoa_fee).toEqual({ amount: 800, frequency: 'Annually' });
    expect(out.tax_annual).toBe(2100);
    expect(out.virtual_tour_url).toBe('https://tour.example/cab1');
  });

  it('builds the portal URL from the listing id', () => {
    const out = formatListing('AbCd1234', SAMPLE);
    expect(out.url).toBe('https://portal.onehome.com/en-US/properties/AbCd1234');
  });

  it('selects the lowest-Order media item as the primary photo', () => {
    const out = formatListing(SAMPLE.id!, SAMPLE);
    expect(out.primary_photo_url).toBe('https://cdn/y/m.jpg');
    expect(out.primary_thumbnail_url).toBe('https://cdn/y/th.jpg');
    expect(out.photo_count).toBe(2);
  });

  it('omits fields the raw record does not populate', () => {
    const minimal: RawListingDetail = { id: 'X', property: { ListPrice: 100000 } };
    const out = formatListing('X', minimal);
    expect(out.list_price).toBe(100000);
    expect(out.address_full).toBeUndefined();
    expect(out.beds).toBeUndefined();
    expect(out.major_change).toBeUndefined();
    expect(out.photo_count).toBe(0);
  });

  it('preserves the listing key from customProperty for MLS reference', () => {
    const out = formatListing(SAMPLE.id!, SAMPLE);
    expect(out.mls_listing_key).toBe('CANOPY:4276702');
    expect(out.source_listing_id).toBe('4276702');
  });

  describe('description handling (issues #13 + #14)', () => {
    const withRemarks: RawListingDetail = {
      id: 'X',
      property: {
        ListPrice: 500000,
        PublicRemarks:
          'Stunning lakefront cottage in Rumbling Bald with private dock and hot tub. Unfinished basement for storage.',
      },
    };

    it('omits the raw description by default (context-savings default)', () => {
      const out = formatListing('X', withRemarks);
      expect(out.description).toBeUndefined();
    });

    it('includes the raw description when include_description: true', () => {
      const out = formatListing('X', withRemarks, { includeDescription: true });
      expect(out.description).toContain('lakefront cottage');
    });

    it('always populates extracted_features when there is a description', () => {
      const out = formatListing('X', withRemarks);
      expect(out.extracted_features).toBeDefined();
      expect(out.extracted_features!.lake_front).toBe(true);
      expect(out.extracted_features!.hot_tub).toBe(true);
      expect(out.extracted_features!.basement).toBe('unfinished');
      expect(out.extracted_features!.dock).toBe('private');
      expect(out.extracted_features!.community).toBe('Rumbling Bald');
    });

    it('omits extracted_features when there is no description', () => {
      const out = formatListing('X', { id: 'X', property: { ListPrice: 100000 } });
      expect(out.extracted_features).toBeUndefined();
    });
  });
});

describe('pickPrimaryPhoto', () => {
  it('returns photo_count=0 for empty media', () => {
    expect(pickPrimaryPhoto(undefined)).toEqual({ photo_count: 0 });
    expect(pickPrimaryPhoto([])).toEqual({ photo_count: 0 });
  });
});

describe('buildPropertyUrl', () => {
  it('URL-encodes the listing id', () => {
    expect(buildPropertyUrl('abc/def')).toBe(
      'https://portal.onehome.com/en-US/properties/abc%2Fdef'
    );
  });
});
