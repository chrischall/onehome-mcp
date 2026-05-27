/**
 * Shared formatting helpers — turn raw GraphQL `ListingDetail`
 * responses into the flatter `FormattedListing` shape that tools
 * expose to MCP callers. Keeps each tool file thin.
 */

import { extractFeatures, loadCommunities, type ExtractedFeatures } from './features.js';

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
  /**
   * MLS-feed-supplied flat address string. Sometimes differs from the
   * primary address we build from StreetNumber/StreetName/etc. (e.g.
   * different MLS feeds for the same listing carry different parsings).
   * Surface as `address_alternates` when it disagrees with the primary.
   */
  UnparsedAddress?: string;
}

export interface RawListingDetail {
  id?: string;
  createdAt?: string;
  hideWhenUnauth?: boolean;
  property?: RawProperty;
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
  /** `null` when raw value is the 0/1 not-yet-assessed placeholder. (Issue #17.) */
  tax_annual?: number | null;
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
 * Convert an HOA `{amount, frequency}` to monthly USD, rounded to the
 * nearest dollar. Returns `null` for unknown frequency strings (with a
 * stderr warning) or when the inputs are absent. (Issue #15.)
 */
export function hoaToMonthlyUsd(
  amount: number | undefined,
  frequency: string | undefined
): number | null {
  if (typeof amount !== 'number' || !frequency) return null;
  let monthly: number;
  switch (frequency) {
    case 'Monthly':
      monthly = amount;
      break;
    case 'Annually':
      monthly = amount / 12;
      break;
    case 'Quarterly':
      monthly = amount / 3;
      break;
    case 'SemiAnnually':
      monthly = amount / 6;
      break;
    case 'Weekly':
      monthly = (amount * 52) / 12;
      break;
    default:
      console.error(
        `[onehome-mcp] hoa_monthly_usd: unknown AssociationFeeFrequency "${frequency}" — returning null`
      );
      return null;
  }
  return Math.round(monthly);
}

/**
 * Days between `at` (an ISO timestamp) and now, floored. Returns null
 * if the timestamp is missing or unparseable.
 */
export function daysSince(at: string | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  const delta = Date.now() - t;
  return Math.floor(delta / 86_400_000);
}

/**
 * Normalize an address for equality checks — collapse whitespace, drop
 * punctuation, and lowercase. Used to dedupe `address_alternates`
 * against the primary `address_full`.
 */
function normalizeAddressForCompare(s: string | undefined): string {
  if (!s) return '';
  return s.toLowerCase().replace(/[,#.]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Collect alternate address strings from the raw payload, excluding any
 * that match the primary. Currently sources from
 * `customProperty.UnparsedAddress` (the only flat-string address we see
 * on `services.onehome.com`); returns an empty array when no other
 * sources surface anything. (Issue #25.)
 */
export function collectAddressAlternates(
  primary: string | undefined,
  cp: RawCustomProperty
): string[] {
  const primaryNorm = normalizeAddressForCompare(primary);
  const candidates: string[] = [];
  if (cp.UnparsedAddress) candidates.push(cp.UnparsedAddress);
  const seen = new Set<string>();
  const alternates: string[] = [];
  for (const candidate of candidates) {
    const norm = normalizeAddressForCompare(candidate);
    if (!norm) continue;
    if (norm === primaryNorm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    alternates.push(candidate);
  }
  return alternates;
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
  // address_alternates: pick up any flat MLS-feed address that disagrees
  // with the primary we built from StreetNumber/StreetName/etc.
  // (Issue #25 — pinned for now to customProperty.UnparsedAddress;
  // omitted entirely when nothing alternate is present.)
  const alternates = collectAddressAlternates(addressFull, cp);
  if (alternates.length > 0) out.address_alternates = alternates;
  if (street) out.street = street;
  if (city) out.city = city;
  if (p.StateOrProvince) out.state = p.StateOrProvince;
  if (p.PostalCode) out.zip = p.PostalCode;
  if (typeof p.ListPrice === 'number') out.list_price = p.ListPrice;
  if (typeof p.ClosePrice === 'number') out.close_price = p.ClosePrice;
  if (typeof p.PreviousListPrice === 'number')
    out.previous_list_price = p.PreviousListPrice;
  // price_drop_*: null when either side of the math is missing.
  // (Issue #16.)
  if (
    typeof p.ListPrice === 'number' &&
    typeof p.PreviousListPrice === 'number' &&
    p.PreviousListPrice > 0
  ) {
    const drop = p.PreviousListPrice - p.ListPrice;
    out.price_drop_amount = drop;
    out.price_drop_percent =
      Math.round((drop / p.PreviousListPrice) * 1000) / 10;
  } else {
    out.price_drop_amount = null;
    out.price_drop_percent = null;
  }
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
  // tax_annual: 0 and 1 are not-yet-assessed placeholders (new
  // construction). Null them out so callers don't treat $1 as real.
  // (Issue #17.) tax_is_estimated is omitted until upstream surfaces a
  // county-estimate marker — guessing would be worse than absent.
  if (typeof p.TaxAnnualAmount === 'number') {
    out.tax_annual = p.TaxAnnualAmount <= 1 ? null : p.TaxAnnualAmount;
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
