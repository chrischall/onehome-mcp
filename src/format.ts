/**
 * Shared formatting helpers — turn raw GraphQL `ListingDetail`
 * responses into the flatter `FormattedListing` shape that tools
 * expose to MCP callers. Keeps each tool file thin.
 */

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
  media?: RawMediaItem[];
  customProperty?: RawCustomProperty;
  rooms?: Array<Record<string, unknown>>;
  openHouse?: Array<Record<string, unknown>>;
}

export interface FormattedListing {
  listing_id: string;
  url: string;
  address_full?: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  list_price?: number;
  close_price?: number;
  previous_list_price?: number;
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
  hoa_fee?: { amount: number; frequency?: string };
  tax_annual?: number;
  tax_year?: number;
  description?: string;
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

export function formatListing(
  listingId: string,
  raw: RawListingDetail
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
  };
  if (addressFull) out.address_full = addressFull;
  if (street) out.street = street;
  if (city) out.city = city;
  if (p.StateOrProvince) out.state = p.StateOrProvince;
  if (p.PostalCode) out.zip = p.PostalCode;
  if (typeof p.ListPrice === 'number') out.list_price = p.ListPrice;
  if (typeof p.ClosePrice === 'number') out.close_price = p.ClosePrice;
  if (typeof p.PreviousListPrice === 'number')
    out.previous_list_price = p.PreviousListPrice;
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
  if (typeof p.AssociationFee === 'number') {
    out.hoa_fee = {
      amount: p.AssociationFee,
      ...(p.AssociationFeeFrequency
        ? { frequency: p.AssociationFeeFrequency }
        : {}),
    };
  }
  if (typeof p.TaxAnnualAmount === 'number') out.tax_annual = p.TaxAnnualAmount;
  if (typeof p.TaxYear === 'number') out.tax_year = p.TaxYear;
  if (p.PublicRemarks) out.description = p.PublicRemarks;
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
