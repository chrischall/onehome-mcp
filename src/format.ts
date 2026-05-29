/**
 * Shared formatting helpers — turn raw GraphQL `ListingDetail`
 * responses into the flatter `FormattedListing` shape that tools
 * expose to MCP callers. Keeps each tool file thin.
 */

import {
  hoaToMonthlyUsd,
  daysSince,
  priceDrop,
  sqftToAcres,
  cleanTaxAnnual,
  collectAddressAlternates,
} from '@chrischall/realty-core';
import { extractFeatures, loadCommunities, type ExtractedFeatures } from './features.js';

export { hoaToMonthlyUsd, daysSince } from '@chrischall/realty-core';

export interface FormatOptions {
  /**
   * Include the raw `description` (PublicRemarks) in the output.
   * Defaults to `false` because callers usually keyword-parse and
   * discard it; the server-side `extracted_features` covers the
   * common extraction needs. Pass `true` to keep the full prose.
   */
  includeDescription?: boolean;
}

export interface RawProperty {
  OriginatingSystemKey?: string;
  StreetAdditionalInfo?: string;
  StreetNumber?: string;
  StreetDirPrefix?: string;
  StreetName?: string;
  StreetSuffix?: string;
  StreetDirSuffix?: string;
  UnitNumber?: string;
  City?: string;
  PostalCity?: string;
  StateOrProvince?: string;
  PostalCode?: string;
  PostalCodePlus4?: string;
  NewConstructionYN?: boolean;
  ListPrice?: number;
  ListingId?: string;
  CLIP?: string;
  LivingArea?: number;
  PropertyType?: string;
  PropertySubType?: string;
  BedroomsTotal?: number;
  BathroomsTotalInteger?: number;
  LivingAreaTotal?: number;
  BuildingAreaTotal?: number;
  AvailabilityDate?: string;
  Latitude?: number;
  Longitude?: number;
  LotSizeArea?: number;
  LotSizeUnits?: string;
  ClosePrice?: number;
  StandardStatus?: string;
  MajorChangeType?: string;
  MajorChangeTimestamp?: string;
  PreviousListPrice?: number;
  AboveGradeFinishedArea?: number;
  AboveGradeFinishedAreaUnits?: string;
  YearBuilt?: number;
  AssociationFee?: number;
  AssociationFeeFrequency?: string;
  TaxAnnualAmount?: number;
  TaxYear?: number;
  PublicRemarks?: string;
  VirtualTourURLUnbranded?: string;
  VirtualTourURLBranded?: string;
}

export interface RawImageDetails {
  mediaUrl?: string;
  width?: number;
  height?: number;
}

export interface RawMediaImage {
  Thumbnail?: RawImageDetails;
  Medium?: RawImageDetails;
  Large?: RawImageDetails;
}

export interface RawMediaItem {
  LongDescription?: string;
  ShortDescription?: string;
  ImageOf?: string;
  MediaKey?: string;
  MediaType?: string;
  Order?: number;
  Image?: RawMediaImage;
}

export interface RawCustomProperty {
  ListingKey?: string;
  ListingId?: string;
  FIPSCode?: string;
}

export interface RawListingDetail {
  id?: string;
  createdAt?: string;
  hideWhenUnauth?: boolean;
  property?: RawProperty;
  // MLS-feed flat address; listingDetail-level sibling of customProperty (#25).
  UnparsedAddress?: string;
  media?: RawMediaItem[];
  customProperty?: RawCustomProperty;
  rooms?: Array<Record<string, unknown>>;
  openHouse?: Array<Record<string, unknown>>;
}

export interface FormattedListing {
  listing_id: string;
  url: string;
  /**
   * Sheets-paste-ready hyperlink formula pointing at the same listing.
   * Always present (mirrors `url`). Pasting it into Google Sheets renders
   * as a clickable "OneHome" link. (Issue #24.)
   */
  portal_url_hyperlink: string;
  address_full?: string;
  /**
   * Alternate addresses from other MLS feeds, prior listings, or parcel
   * variants. Excludes the primary (kept in `address_full`). Omitted
   * when empty/absent. (Issue #25.)
   */
  address_alternates?: string[];
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  list_price?: number;
  close_price?: number;
  previous_list_price?: number;
  /** `previous_list_price - list_price`. `null` when either is missing. (Issue #16.) */
  price_drop_amount?: number | null;
  /** `(previous - current) / previous * 100`, rounded to 0.1. (Issue #16.) */
  price_drop_percent?: number | null;
  price_per_sqft?: number;
  property_type?: string;
  property_sub_type?: string;
  beds?: number;
  baths?: number;
  living_area_sqft?: number;
  lot_size?: { area: number; units: string };
  /**
   * Lot size in acres, derived from `lot_size.{area, units}` — acreage is
   * the unit that matters for rural/mountain/land listings. Unit-aware:
   * an already-`Acres` lot is rounded to 2 dp; a `Square Feet` lot is
   * `round(area / 43560, 2)`. `null` (never `0`) when the lot is
   * absent/zero or the units aren't recognized (condos, missing data).
   * (Issue #82.)
   */
  lot_size_acres?: number | null;
  year_built?: number;
  latitude?: number;
  longitude?: number;
  status?: string;
  major_change?: { type: string; at?: string };
  /** Days since `major_change.at` when type is NewListing. (Issue #16.) */
  days_on_market?: number | null;
  hoa_fee?: { amount: number; frequency?: string };
  /**
   * Monthly-normalized HOA cost derived from `hoa_fee.{amount, frequency}`.
   * `null` when the frequency is unknown or no fee is reported. (Issue #15.)
   */
  hoa_monthly_usd?: number | null;
  /**
   * Annual property tax. `null` when the raw figure is the
   * not-yet-assessed placeholder portals surface on new construction.
   * The sentinel threshold is the canonical realty-core `< 10` (wider
   * than the old `<= 1` — real new-build listings come back with 0–9
   * placeholders, homes-mcp#17). (Issue #17.)
   */
  tax_annual?: number | null;
  /**
   * `'not_yet_assessed'` when `tax_annual` was nulled out by the
   * sub-$10 placeholder; omitted otherwise. Surfaced so callers get the
   * assessment-status signal rather than an ambiguous `null`. (Issue #17.)
   */
  tax_status?: 'not_yet_assessed';
  tax_year?: number;
  description?: string;
  extracted_features?: ExtractedFeatures;
  virtual_tour_url?: string;
  primary_photo_url?: string;
  primary_thumbnail_url?: string;
  photo_count?: number;
  source_listing_id?: string;
  mls_listing_key?: string;
}

const URL_BASE = 'https://portal.onehome.com/en-US/properties';

function joinNonEmpty(parts: Array<string | undefined>, sep = ' '): string | undefined {
  const cleaned = parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned.join(sep) : undefined;
}

export function pickPrimaryPhoto(media: RawMediaItem[] | undefined): {
  primary_photo_url?: string;
  primary_thumbnail_url?: string;
  photo_count: number;
} {
  if (!media || media.length === 0) return { photo_count: 0 };
  const sorted = [...media].sort((a, b) => (a.Order ?? 0) - (b.Order ?? 0));
  const first = sorted[0]!;
  return {
    primary_photo_url:
      first.Image?.Large?.mediaUrl ?? first.Image?.Medium?.mediaUrl,
    primary_thumbnail_url: first.Image?.Thumbnail?.mediaUrl,
    photo_count: media.length,
  };
}

export function buildPropertyUrl(listingId: string): string {
  return `${URL_BASE}/${encodeURIComponent(listingId)}`;
}

/**
 * Google-Sheets `HYPERLINK` formula pointing at the OneHome portal
 * URL for `listingId`. Pasting the returned string into a Sheets cell
 * renders as a clickable "OneHome" link. (Issue #24.)
 */
export function buildPortalUrlHyperlink(listingId: string): string {
  return `=HYPERLINK("${buildPropertyUrl(listingId)}","OneHome")`;
}

/**
 * Derive lot size in acres from OneHome's unit-tagged lot size, rounded
 * to 2 dp (issue #82). Acreage is the unit that matters for
 * rural/mountain/land listings, but OneHome reports lot size as a
 * `{area, units}` pair where `units` is the RESO `LotSizeUnits` enum
 * (commonly "Acres" or "Square Feet"), so the conversion is unit-aware
 * rather than a blind sqft/43560.
 *
 *   - "Acres" (any case, with/without trailing s) → area, rounded to 2 dp.
 *   - "Square Feet" / "SquareFeet" / "Square Foot" → area / 43560, 2 dp.
 *
 * Null-safe: returns `null` (never `0`) when the area is missing,
 * non-numeric, `0`, or a positive value that rounds to `0` acres (a tiny
 * micro-lot — the smallest non-null is ~218 sq ft → 0.01). A `0` lot is
 * treated as absent — condos / missing data — matching how `lot_size`
 * itself is omitted rather than reporting a real "0 acre" lot. Returns
 * `null` (with a stderr warning) when the units string isn't recognized,
 * rather than guessing.
 *
 * Thin unit-aware wrapper over the canonical sqft-only `sqftToAcres`
 * (realty-core): the Square-Feet branch delegates to it (which carries
 * the same round-to-2dp + tiny-lot guard), and the Acres branch rounds
 * to 2 dp with the identical "never 0" guard. The canonical helper is
 * deliberately sqft-only; onehome's RESO `LotSizeUnits` feed needs this
 * wrapper because a lot may already be expressed in acres.
 */
export function lotSizeAcres(
  area: number | undefined | null,
  units: string | undefined | null
): number | null {
  if (typeof area !== 'number' || !Number.isFinite(area) || area <= 0) {
    return null;
  }
  const normalized = (units ?? '').trim().toLowerCase().replace(/\s+/g, '');
  switch (normalized) {
    case 'acres':
    case 'acre': {
      // Already acres — round to 2 dp with the same "never 0" guard the
      // canonical sqft helper applies, so a sub-0.005 acre lot reports
      // `null` rather than a misleading `0`.
      const rounded = Math.round(area * 100) / 100;
      return rounded > 0 ? rounded : null;
    }
    case 'squarefeet':
    case 'squarefoot':
    case 'sqft':
      // Square feet — delegate to the canonical converter (round-to-2dp
      // + tiny-lot `null` guard live there).
      return sqftToAcres(area);
    default:
      console.error(
        `[onehome-mcp] lot_size_acres: unrecognized LotSizeUnits "${units ?? ''}" — returning null`
      );
      return null;
  }
}

export function formatListing(
  listingId: string,
  raw: RawListingDetail,
  opts: FormatOptions = {}
): FormattedListing {
  const p = raw.property ?? {};
  const cp = raw.customProperty ?? {};
  const street = joinNonEmpty([
    p.StreetNumber,
    p.StreetDirPrefix,
    p.StreetName,
    p.StreetSuffix,
    p.StreetDirSuffix,
    p.UnitNumber ? `#${p.UnitNumber}` : undefined,
  ]);
  const city = p.City ?? p.PostalCity;
  const stateZip = joinNonEmpty([p.StateOrProvince, p.PostalCode]);
  const addressFull = joinNonEmpty(
    [street, joinNonEmpty([city, stateZip], ', ')],
    ', '
  );
  const photos = pickPrimaryPhoto(raw.media);
  const out: FormattedListing = {
    listing_id: listingId,
    url: buildPropertyUrl(listingId),
    portal_url_hyperlink: buildPortalUrlHyperlink(listingId),
  };
  if (addressFull) out.address_full = addressFull;
  // address_alternates: flat MLS-feed address (#25) deduped against the primary.
  const alternates = collectAddressAlternates(addressFull, [raw.UnparsedAddress]);
  if (alternates.length > 0) out.address_alternates = alternates;
  if (street) out.street = street;
  if (city) out.city = city;
  if (p.StateOrProvince) out.state = p.StateOrProvince;
  if (p.PostalCode) out.zip = p.PostalCode;
  if (typeof p.ListPrice === 'number') out.list_price = p.ListPrice;
  if (typeof p.ClosePrice === 'number') out.close_price = p.ClosePrice;
  if (typeof p.PreviousListPrice === 'number')
    out.previous_list_price = p.PreviousListPrice;
  // price_drop_*: derived from the canonical realty-core `priceDrop`,
  // reshaped to onehome's two flat fields. Canonical arg order is
  // `(previous, current)` and it returns a single `{amount, percent}`
  // (or `null` for no real drop — missing input, or current >= previous);
  // onehome splits that into `price_drop_amount` / `price_drop_percent`,
  // both `null` when there is no drop. (Issue #16.)
  const drop = priceDrop(p.PreviousListPrice, p.ListPrice);
  out.price_drop_amount = drop?.amount ?? null;
  out.price_drop_percent = drop?.percent ?? null;
  const sqft = p.LivingAreaTotal ?? p.LivingArea ?? p.BuildingAreaTotal;
  if (typeof sqft === 'number') {
    out.living_area_sqft = sqft;
    if (typeof p.ListPrice === 'number' && sqft > 0) {
      out.price_per_sqft = Math.round((p.ListPrice / sqft) * 100) / 100;
    }
  }
  if (p.PropertyType) out.property_type = p.PropertyType;
  if (p.PropertySubType) out.property_sub_type = p.PropertySubType;
  if (typeof p.BedroomsTotal === 'number') out.beds = p.BedroomsTotal;
  if (typeof p.BathroomsTotalInteger === 'number')
    out.baths = p.BathroomsTotalInteger;
  if (typeof p.LotSizeArea === 'number') {
    out.lot_size = {
      area: p.LotSizeArea,
      units: p.LotSizeUnits ?? 'unspecified',
    };
  }
  // lot_size_acres is always present — `null` (never `0`) for condos /
  // missing lot data or unrecognized units. Unit-aware: derived from the
  // raw {area, units}, converting Square Feet → acres. (Issue #82.)
  out.lot_size_acres = lotSizeAcres(p.LotSizeArea, p.LotSizeUnits);
  if (typeof p.YearBuilt === 'number') out.year_built = p.YearBuilt;
  if (typeof p.Latitude === 'number') out.latitude = p.Latitude;
  if (typeof p.Longitude === 'number') out.longitude = p.Longitude;
  if (p.StandardStatus) out.status = p.StandardStatus;
  if (p.MajorChangeType) {
    out.major_change = {
      type: p.MajorChangeType,
      ...(p.MajorChangeTimestamp ? { at: p.MajorChangeTimestamp } : {}),
    };
  }
  // days_on_market — derived from a NewListing major_change timestamp.
  // null when the listing isn't a NewListing (or has no timestamp).
  // (Issue #16.)
  if (p.MajorChangeType === 'NewListing' && p.MajorChangeTimestamp) {
    out.days_on_market = daysSince(p.MajorChangeTimestamp);
  } else {
    out.days_on_market = null;
  }
  if (typeof p.AssociationFee === 'number') {
    out.hoa_fee = {
      amount: p.AssociationFee,
      ...(p.AssociationFeeFrequency
        ? { frequency: p.AssociationFeeFrequency }
        : {}),
    };
  }
  // hoa_monthly_usd is always present — `null` for unknown frequency or
  // missing fee. (Issue #15.)
  out.hoa_monthly_usd = hoaToMonthlyUsd(p.AssociationFee, p.AssociationFeeFrequency);
  // tax_annual: low values are not-yet-assessed placeholders (new
  // construction). The canonical realty-core `cleanTaxAnnual` nulls them
  // out and returns the assessment status; onehome adopts its wider
  // `< 10` sentinel (vs the old `<= 1`) and surfaces `tax_status`.
  // (Issue #17.) tax_is_estimated is omitted until upstream surfaces a
  // county-estimate marker — guessing would be worse than absent.
  if (typeof p.TaxAnnualAmount === 'number') {
    const { tax_annual, tax_status } = cleanTaxAnnual(p.TaxAnnualAmount);
    out.tax_annual = tax_annual;
    if (tax_status) out.tax_status = tax_status;
  }
  if (typeof p.TaxYear === 'number') out.tax_year = p.TaxYear;
  // Always compute extracted_features (cheap, useful) so callers can
  // drop the raw description. The description itself is opt-in.
  if (p.PublicRemarks) {
    out.extracted_features = extractFeatures(p.PublicRemarks, loadCommunities());
    if (opts.includeDescription === true) out.description = p.PublicRemarks;
  }
  if (p.VirtualTourURLUnbranded ?? p.VirtualTourURLBranded) {
    out.virtual_tour_url =
      p.VirtualTourURLUnbranded ?? p.VirtualTourURLBranded;
  }
  if (photos.primary_photo_url) out.primary_photo_url = photos.primary_photo_url;
  if (photos.primary_thumbnail_url)
    out.primary_thumbnail_url = photos.primary_thumbnail_url;
  out.photo_count = photos.photo_count;
  if (p.ListingId) out.source_listing_id = p.ListingId;
  if (cp.ListingKey) out.mls_listing_key = cp.ListingKey;
  return out;
}
