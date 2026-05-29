/**
 * Canonical GraphQL operations used by onehome-mcp.
 *
 * Each export is a `{ operationName, query }` pair ready to hand to
 * `OneHomeTransport.graphql({ ..., variables })`.
 *
 * Field sets here mirror the actual fragments shipped in the
 * portal.onehome.com Angular bundle (main.d55f832710c85452.js, captured
 * 2026-05-26), down to capitalization (`MajorChangeTimestamp` etc.) and
 * value shapes (`SortCriteria = { name, order }`, `PageInput =
 * { pageNum, size }`). We inline the fragments rather than reference
 * them by name so the documents are self-contained.
 *
 * Power users wanting a field we don't expose should use
 * `onehome_graphql` — the escape-hatch tool that takes a raw document.
 */

import type { GraphQLRequest } from './transport.js';

// -----------------------------------------------------------------
// Fragments
// -----------------------------------------------------------------

const FRAGMENT_PAGE_INFO = `
fragment pageInfo on PageInfo {
  totalElements
  totalPages
  pageNumber
  pageSize
}
`;

const FRAGMENT_IMAGE_DETAILS = `
fragment imageDetails on Image {
  mediaUrl
  width
  height
  size
}
`;

/**
 * Per-listing facts surfaced by search/property tools. A subset of the
 * upstream `shortListingDetails` fragment, narrowed to the fields the
 * tool layer actually formats. Names and types match the bundle.
 */
const FRAGMENT_LISTING_CARD = `
fragment listingCard on ListingDetail {
  id
  hideWhenUnauth
  property {
    OriginatingSystemKey
    OriginatingSystemName
    StreetAdditionalInfo
    StreetNumber
    StreetDirPrefix
    StreetName
    StreetSuffix
    StreetDirSuffix
    UnitNumber
    City
    PostalCity
    StateOrProvince
    PostalCode
    NewConstructionYN
    ListPrice
    ListingId
    LivingArea
    PropertyType
    PropertySubType
    BedroomsTotal
    BathroomsTotalInteger
    LivingAreaTotal
    BuildingAreaTotal
    Latitude
    Longitude
    LotSizeArea
    LotSizeUnits
    ClosePrice
    StandardStatus
    MajorChangeType
    MajorChangeTimestamp
    PreviousListPrice
  }
  media {
    LongDescription
    ShortDescription
    Order
    MediaType
    Image {
      Thumbnail {
        ...imageDetails
      }
      Medium {
        ...imageDetails
      }
    }
  }
  UnparsedAddress
  customProperty {
    ListingKey
    FIPSCode
  }
}
${FRAGMENT_IMAGE_DETAILS}
`;

const FRAGMENT_SAVED_SEARCH = `
fragment savedSearchData on SavedSearch {
  id
  name
  createdAt
  updatedAt
  setType
  listingIds
  isActive
  resourceID
  userQuery {
    fieldName
    type
    values
  }
  polygon {
    latitude
    longitude
  }
}
`;

// -----------------------------------------------------------------
// User + groups (groups live nested on user — no separate query needed)
// -----------------------------------------------------------------

export function buildGetOneHomeUser(): GraphQLRequest {
  return {
    operationName: 'GetOneHomeUser',
    query: `
query GetOneHomeUser {
  user {
    id
    firstName
    lastName
    email
    phone
    registered
    lastAccessedGroupId
    lastAccessedSavedSearchId
    userWelcomed
    groups {
      id
      firstName
      lastName
      contactId
      emails
      contactStatus
      createdAt
      shareToken
      agent {
        id
        firstName
        lastName
        fullName
        email
        phone
        officeName
        officePhone
        teamName
        mls {
          mlsid
        }
      }
    }
  }
}
`.trim(),
  };
}

// -----------------------------------------------------------------
// Saved searches (consumer-readable lookup is by-searchId, not by-groupId
// — the by-groupId variant is agent-only and returns "Access Denied" for
// a consumer-share session)
// -----------------------------------------------------------------

export function buildGetSavedSearchBySearchId(searchId: string): GraphQLRequest {
  return {
    operationName: 'GetSavedSearchBySearchId',
    query: `
query GetSavedSearchBySearchId($searchId: String!) {
  savedSearch(id: $searchId) {
    ...savedSearchData
  }
}
${FRAGMENT_SAVED_SEARCH}
`.trim(),
    variables: { searchId },
  };
}

// -----------------------------------------------------------------
// Listings — two paths:
//   A. listings(groupId, browseParameter)
//      Free-form filter via BrowseParameter (searchQuery / sort / pageInput).
//      Consumer access depends on what the agent shared — often returns 0
//      because the consumer view is scoped to a saved search, not the
//      group as a whole.
//   B. listingsBySavedSearchId(groupId, osks, savedSearchId, …)
//      The canonical consumer-shared-collection view. Caller supplies
//      `osks` = the listing-id array from the SavedSearch.listingIds.
//      This is what the portal renders for the "Homes at <name>" page.
// -----------------------------------------------------------------

export interface BrowseParameter {
  searchQuery?: string | null;
  sort?: { name: string; order: 'ASC' | 'DESC' } | null;
  pageInput?: { pageNum: number; size: number };
}

export function buildGetListings(args: {
  groupId: string;
  browseParameter?: BrowseParameter;
  includeDislikes?: boolean;
}): GraphQLRequest {
  return {
    operationName: 'GetListings',
    query: `
query GetListings($groupId: String!, $browseParameter: BrowseParameter, $includeDislikes: Boolean) {
  listings(groupId: $groupId, browseParameter: $browseParameter, includeDislikes: $includeDislikes) {
    pageInfo {
      ...pageInfo
    }
    listings {
      ...listingCard
    }
  }
}
${FRAGMENT_PAGE_INFO}
${FRAGMENT_LISTING_CARD}
`.trim(),
    variables: {
      groupId: args.groupId,
      browseParameter: args.browseParameter ?? {
        pageInput: { pageNum: 0, size: 50 },
      },
      includeDislikes: args.includeDislikes ?? false,
    },
  };
}

export function buildGetSavedListings(args: {
  groupId: string;
  savedSearchId: string;
  listingIds: string[];
  sort?: { name: string; order: 'ASC' | 'DESC' };
  pageInput?: { pageNum: number; size: number };
  includeDislikes?: boolean;
}): GraphQLRequest {
  return {
    operationName: 'GetSavedListings',
    query: `
query GetSavedListings($groupId: String!, $listingIds: [String!]!, $sort: SortCriteria, $pageInput: PageInput, $savedSearchId: String!, $includeDislikes: Boolean!, $suppressEvent: Boolean!) {
  listingsBySavedSearchId(groupId: $groupId, osks: $listingIds, sort: $sort, pageInput: $pageInput, savedSearchId: $savedSearchId, includeDislikes: $includeDislikes, suppressEvent: $suppressEvent) {
    pageInfo {
      ...pageInfo
    }
    listings {
      ...listingCard
    }
  }
}
${FRAGMENT_PAGE_INFO}
${FRAGMENT_LISTING_CARD}
`.trim(),
    variables: {
      groupId: args.groupId,
      savedSearchId: args.savedSearchId,
      listingIds: args.listingIds,
      sort: args.sort ?? { name: 'property.MajorChangeTimestamp', order: 'DESC' },
      pageInput: args.pageInput ?? { pageNum: 0, size: 50 },
      includeDislikes: args.includeDislikes ?? false,
      suppressEvent: true,
    },
  };
}

// -----------------------------------------------------------------
// Free-text suggestion search (works without a groupId scope)
// -----------------------------------------------------------------

export function buildListingSuggestionsSearch(args: {
  browseParameter: string;
  groupId?: string;
}): GraphQLRequest {
  return {
    operationName: 'ListingSuggestionsSearch',
    query: `
query ListingSuggestionsSearch($browseParameter: String!, $groupId: String) {
  listingSuggestionsSearch(browseParameter: $browseParameter, groupId: $groupId) {
    id
    listingId
    postalCode
    city
    postalCity
    stateOrProvince
    streetName
    streetNumber
    streetAdditionalInfo
    unitNumber
    streetSuffix
    streetDirPrefix
    streetDirSuffix
    bedroomsTotal
    bathroomsTotalInteger
    listPrice
    media {
      Image {
        Thumbnail {
          mediaUrl
          width
          height
        }
      }
    }
  }
}
`.trim(),
    variables: {
      browseParameter: args.browseParameter,
      groupId: args.groupId ?? null,
    },
  };
}

// -----------------------------------------------------------------
// Listing detail
// -----------------------------------------------------------------

export function buildListingById(args: {
  listingId: string;
  groupId: string;
  savedSearchId?: string;
}): GraphQLRequest {
  return {
    operationName: 'ListingById',
    query: `
query ListingById($listingId: String!, $groupId: String!, $savedSearchId: String, $suppressEvent: Boolean = true) {
  listingDetail(listingId: $listingId, groupId: $groupId, savedSearchId: $savedSearchId, suppressEvent: $suppressEvent) {
    id
    createdAt
    hideWhenUnauth
    property {
      OriginatingSystemKey
      OriginatingSystemName
      StreetAdditionalInfo
      StreetNumber
      StreetDirPrefix
      StreetName
      StreetSuffix
      StreetDirSuffix
      UnitNumber
      City
      PostalCity
      StateOrProvince
      PostalCode
      PostalCodePlus4
      NewConstructionYN
      ListPrice
      ListingId
      CLIP
      LivingArea
      PropertyType
      PropertySubType
      BedroomsTotal
      BathroomsTotalInteger
      LivingAreaTotal
      BuildingAreaTotal
      AvailabilityDate
      Latitude
      Longitude
      LotSizeArea
      LotSizeUnits
      ClosePrice
      MajorChangeType
      MajorChangeTimestamp
      PreviousListPrice
      StandardStatus
      AboveGradeFinishedArea
      AboveGradeFinishedAreaUnits
      WaterSource
      Sewer
      Utilities
      CommonInterest
      YearBuilt
      AssociationFee
      AssociationFeeFrequency
      TaxAnnualAmount
      TaxYear
      PublicRemarks
      VirtualTourURLUnbranded
      VirtualTourURLBranded
    }
    UnparsedAddress
    customProperty {
      ListingKey
      FIPSCode
    }
    rooms {
      RoomType
      RoomLevel
      RoomDimensions
      RoomLength
      RoomWidth
      RoomFeatures
      RoomFlooring
      RoomDescription
    }
    openHouse {
      OpenHouseDate
      OpenHouseEndTime
      OpenHouseStartTime
      OpenHouseStatus
      OpenHouseType
      OpenHouseRemarks
    }
  }
}
`.trim(),
    variables: {
      listingId: args.listingId,
      groupId: args.groupId,
      savedSearchId: args.savedSearchId ?? null,
      suppressEvent: true,
    },
  };
}

export function buildMediaListingById(args: {
  listingId: string;
  groupId: string;
}): GraphQLRequest {
  return {
    operationName: 'MediaListingById',
    query: `
query MediaListingById($listingId: String!, $groupId: String!, $suppressEvent: Boolean = true) {
  listingDetail(listingId: $listingId, groupId: $groupId, suppressEvent: $suppressEvent) {
    id
    media {
      LongDescription
      ShortDescription
      ImageOf
      MediaKey
      MediaType
      Order
      Image {
        Thumbnail {
          ...imageDetails
        }
        Medium {
          ...imageDetails
        }
        Large {
          ...imageDetails
        }
      }
    }
  }
}
${FRAGMENT_IMAGE_DETAILS}
`.trim(),
    variables: {
      listingId: args.listingId,
      groupId: args.groupId,
      suppressEvent: true,
    },
  };
}

// -----------------------------------------------------------------
// Local-Logic endpoints (REST, not GraphQL — see `OneHomeClient.rest`).
//
// The bundle wraps these in Apollo `@rest` directives, but `@rest`
// is a client-side Apollo construct — the server returns a GraphQL
// "Field 'getLocalLogicSchools' is undefined" error if you actually
// POST the document. We hit the underlying REST URLs directly from
// `src/tools/schools.ts`:
//
//   GET /api/locallogic/scores?lat=&lng=&locale=    walk score
//   GET /api/locallogic/schools?lat=&lng=&locale=   schools (often
//                                                   403 for consumer
//                                                   sessions — the
//                                                   bundle still
//                                                   asks for it but
//                                                   we surface the
//                                                   error cleanly)
// -----------------------------------------------------------------
