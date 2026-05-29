/**
 * Shared address-string helpers — the small joins and street-from-parts
 * builders that the format + by-address + search tool files each had
 * their own copy of. Hoisted here so the three converge (and the
 * `joinNonEmpty` `string` vs `string | undefined` divergence is settled
 * on a single signature).
 */

/**
 * Join the non-empty, trimmed parts with `sep`. Returns `undefined`
 * (never `''`) when every part is empty — the format.ts semantics, which
 * lets callers do `if (x) out.field = x`. Callers that want an empty
 * string can coalesce with `?? ''`.
 */
export function joinNonEmpty(
  parts: Array<string | undefined>,
  sep = ' '
): string | undefined {
  const cleaned = parts
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0);
  return cleaned.length > 0 ? cleaned.join(sep) : undefined;
}

/**
 * Capitalized RESO-style street fields (the `property { ... }` shape on
 * `ListingDetail`). A subset is enough for the street-line builder.
 */
export interface PropertyStreetParts {
  StreetNumber?: string;
  StreetDirPrefix?: string;
  StreetName?: string;
  StreetSuffix?: string;
  StreetDirSuffix?: string;
  UnitNumber?: string;
}

/**
 * camelCase street fields as returned by `listingSuggestionsSearch`.
 * Richer than the by-address rung needs, but a single superset interface
 * lets both the by-address and search tools share one declaration.
 */
export interface SuggestionEntry {
  id?: string;
  listingId?: string;
  postalCode?: string;
  city?: string;
  postalCity?: string;
  stateOrProvince?: string;
  streetName?: string;
  streetNumber?: string;
  streetAdditionalInfo?: string;
  unitNumber?: string;
  streetSuffix?: string;
  streetDirPrefix?: string;
  streetDirSuffix?: string;
  bedroomsTotal?: number;
  bathroomsTotalInteger?: number;
  listPrice?: number;
  media?: {
    Image?: {
      Thumbnail?: { mediaUrl?: string; width?: number; height?: number };
    };
  }[];
}

/**
 * Build the single-line street portion (`"126 Sleeping Bear Lane #2"`)
 * from the capitalized RESO property fields. `#unit` is appended when a
 * UnitNumber is present. Returns `undefined` when no parts are set.
 */
export function streetFromProperty(
  p: PropertyStreetParts
): string | undefined {
  return joinNonEmpty([
    p.StreetNumber,
    p.StreetDirPrefix,
    p.StreetName,
    p.StreetSuffix,
    p.StreetDirSuffix,
    p.UnitNumber ? `#${p.UnitNumber}` : undefined,
  ]);
}

/**
 * Build the single-line street portion from the camelCase suggestion
 * fields. Mirrors `streetFromProperty` for the suggestion shape.
 */
export function streetFromSuggestion(s: SuggestionEntry): string | undefined {
  return joinNonEmpty([
    s.streetNumber,
    s.streetDirPrefix,
    s.streetName,
    s.streetSuffix,
    s.streetDirSuffix,
    s.unitNumber ? `#${s.unitNumber}` : undefined,
  ]);
}
