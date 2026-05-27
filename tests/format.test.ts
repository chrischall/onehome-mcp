import { describe, it, expect, vi } from 'vitest';
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

  describe('portal_url_hyperlink (issue #24)', () => {
    it('emits a Google-Sheets HYPERLINK formula for every record', () => {
      const out = formatListing('AbCd1234', SAMPLE);
      expect(out.portal_url_hyperlink).toBe(
        '=HYPERLINK("https://portal.onehome.com/en-US/properties/AbCd1234","OneHome")'
      );
    });

    it('mirrors the per-row url field for the same listing id', () => {
      const out = formatListing('XYZ', { id: 'XYZ', property: { ListPrice: 1 } });
      expect(out.portal_url_hyperlink).toContain(out.url);
    });
  });

  describe('hoa_monthly_usd (issue #15)', () => {
    it('converts Annually → amount / 12, rounded to nearest dollar', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 4967, AssociationFeeFrequency: 'Annually' },
      };
      const out = formatListing('X', raw);
      expect(out.hoa_monthly_usd).toBe(414);
    });

    it('converts Quarterly → amount / 3', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 300, AssociationFeeFrequency: 'Quarterly' },
      };
      expect(formatListing('X', raw).hoa_monthly_usd).toBe(100);
    });

    it('converts Monthly → amount', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 250, AssociationFeeFrequency: 'Monthly' },
      };
      expect(formatListing('X', raw).hoa_monthly_usd).toBe(250);
    });

    it('converts SemiAnnually → amount / 6', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 600, AssociationFeeFrequency: 'SemiAnnually' },
      };
      expect(formatListing('X', raw).hoa_monthly_usd).toBe(100);
    });

    it('converts Weekly → amount * 52 / 12, rounded to nearest dollar', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 100, AssociationFeeFrequency: 'Weekly' },
      };
      // 100 * 52 / 12 = 433.33 -> 433
      expect(formatListing('X', raw).hoa_monthly_usd).toBe(433);
    });

    it('returns null and warns to stderr on unknown frequency', () => {
      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 100, AssociationFeeFrequency: 'Whenever' },
      };
      const out = formatListing('X', raw);
      expect(out.hoa_monthly_usd).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hoa_monthly_usd')
      );
      warnSpy.mockRestore();
    });

    it('returns null when there is no HOA fee at all', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { ListPrice: 1 },
      };
      expect(formatListing('X', raw).hoa_monthly_usd).toBeNull();
    });

    it('returns null when amount is present but frequency is missing', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { AssociationFee: 500 },
      };
      expect(formatListing('X', raw).hoa_monthly_usd).toBeNull();
    });
  });

  describe('derived fields: days_on_market + price_drop (issue #16)', () => {
    it('computes days_on_market from major_change.at when type is NewListing', () => {
      const now = new Date('2026-05-27T12:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);
      try {
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000).toISOString();
        const raw: RawListingDetail = {
          id: 'X',
          property: {
            MajorChangeType: 'NewListing',
            MajorChangeTimestamp: thirtyDaysAgo,
          },
        };
        const out = formatListing('X', raw);
        expect(out.days_on_market).toBe(30);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns null for days_on_market when major_change.type is not NewListing', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: {
          MajorChangeType: 'PriceDecrease',
          MajorChangeTimestamp: '2026-04-01T00:00:00Z',
        },
      };
      expect(formatListing('X', raw).days_on_market).toBeNull();
    });

    it('returns null for days_on_market when there is no major_change', () => {
      const out = formatListing('X', { id: 'X', property: { ListPrice: 1 } });
      expect(out.days_on_market).toBeNull();
    });

    it('computes price_drop_amount and price_drop_percent', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { ListPrice: 480000, PreviousListPrice: 500000 },
      };
      const out = formatListing('X', raw);
      expect(out.price_drop_amount).toBe(20000);
      expect(out.price_drop_percent).toBe(4.0);
    });

    it('rounds price_drop_percent to 0.1', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { ListPrice: 479000, PreviousListPrice: 500000 },
      };
      const out = formatListing('X', raw);
      expect(out.price_drop_amount).toBe(21000);
      // 21000 / 500000 = 4.2% exactly
      expect(out.price_drop_percent).toBe(4.2);
    });

    it('returns null for price_drop fields when previous_list_price is missing', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { ListPrice: 480000 },
      };
      const out = formatListing('X', raw);
      expect(out.price_drop_amount).toBeNull();
      expect(out.price_drop_percent).toBeNull();
    });

    it('returns null for price_drop fields when list_price is missing', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { PreviousListPrice: 500000 },
      };
      const out = formatListing('X', raw);
      expect(out.price_drop_amount).toBeNull();
      expect(out.price_drop_percent).toBeNull();
    });
  });

  describe('tax_annual placeholder cleanup (issue #17)', () => {
    it('nulls out tax_annual when raw value is 1 (new-construction placeholder)', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { TaxAnnualAmount: 1 },
      };
      expect(formatListing('X', raw).tax_annual).toBeNull();
    });

    it('nulls out tax_annual when raw value is 0', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { TaxAnnualAmount: 0 },
      };
      expect(formatListing('X', raw).tax_annual).toBeNull();
    });

    it('preserves real tax_annual values', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: { TaxAnnualAmount: 2100 },
      };
      expect(formatListing('X', raw).tax_annual).toBe(2100);
    });

    it('omits tax_is_estimated when upstream has no estimate flag', () => {
      // Per #17: "If you can't find one, omit the field rather than guess."
      // No county-estimate marker is exposed in the current GraphQL query,
      // so the field is absent rather than emitted as a guess.
      const raw: RawListingDetail = {
        id: 'X',
        property: { TaxAnnualAmount: 2100 },
      };
      const out = formatListing('X', raw);
      expect('tax_is_estimated' in out).toBe(false);
    });
  });

  describe('address_alternates (issue #25)', () => {
    it('omits the field when upstream has no alternate address sources', () => {
      // Pin: until upstream exposes an MLS-specific alternate address feed,
      // the field is absent rather than emitted as an empty array.
      const out = formatListing('X', SAMPLE);
      expect('address_alternates' in out).toBe(false);
    });

    it('surfaces customProperty.UnparsedAddress when distinct from the primary built address', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: {
          StreetNumber: '109',
          StreetName: 'Overlook Point',
          StreetSuffix: 'Ln',
          City: 'Lake Lure',
          StateOrProvince: 'NC',
          PostalCode: '28746',
        },
        customProperty: {
          UnparsedAddress: '169 Overlook Point Ln, Lake Lure, NC 28746',
        },
      };
      const out = formatListing('X', raw);
      expect(out.address_alternates).toEqual([
        '169 Overlook Point Ln, Lake Lure, NC 28746',
      ]);
    });

    it('omits the field when the alternate equals the primary address (case-insensitive)', () => {
      const raw: RawListingDetail = {
        id: 'X',
        property: {
          StreetNumber: '109',
          StreetName: 'Overlook Point',
          StreetSuffix: 'Ln',
          City: 'Lake Lure',
          StateOrProvince: 'NC',
          PostalCode: '28746',
        },
        customProperty: {
          UnparsedAddress: '109 Overlook Point Ln, Lake Lure, NC 28746',
        },
      };
      const out = formatListing('X', raw);
      expect('address_alternates' in out).toBe(false);
    });
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
