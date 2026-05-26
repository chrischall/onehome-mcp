import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OneHomeClient } from '../client.js';
import { textResult } from '../mcp.js';
import { buildMediaListingById } from '../queries.js';
import { extractListingId } from '../url.js';
import type { RawMediaItem } from '../format.js';

interface MediaResponse {
  listingDetail?: {
    id?: string;
    media?: RawMediaItem[];
  };
}

interface FormattedPhoto {
  description?: string;
  short_description?: string;
  order?: number;
  media_type?: string;
  url?: string;
  medium_url?: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
}

export function formatPhoto(m: RawMediaItem): FormattedPhoto | null {
  const large = m.Image?.Large?.mediaUrl;
  const medium = m.Image?.Medium?.mediaUrl;
  const thumb = m.Image?.Thumbnail?.mediaUrl;
  if (!large && !medium && !thumb) return null;
  const dimSource =
    m.Image?.Large ?? m.Image?.Medium ?? m.Image?.Thumbnail ?? null;
  const out: FormattedPhoto = {};
  if (m.LongDescription) out.description = m.LongDescription;
  if (m.ShortDescription) out.short_description = m.ShortDescription;
  if (typeof m.Order === 'number') out.order = m.Order;
  if (m.MediaType) out.media_type = m.MediaType;
  if (large) out.url = large;
  if (medium) out.medium_url = medium;
  if (thumb) out.thumbnail_url = thumb;
  if (dimSource) {
    if (typeof dimSource.width === 'number') out.width = dimSource.width;
    if (typeof dimSource.height === 'number') out.height = dimSource.height;
  }
  return out;
}

export function registerPhotosTools(
  server: McpServer,
  client: OneHomeClient
): void {
  server.registerTool(
    'onehome_get_property_photos',
    {
      title: 'Full photo gallery for a OneHome listing',
      description:
        'Fetch the full media gallery for a OneHome listing. Returns one entry per image with Thumbnail / Medium / Large CDN URLs, dimensions, the listing-room description (LongDescription), and display order. Pass either `listing_id` or a portal URL.',
      annotations: {
        title: 'Full photo gallery for a OneHome listing',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        group_id: z.string().optional(),
        listing_id: z.string().optional(),
        url: z.string().optional(),
      },
    },
    async (i) => {
      const id = i.listing_id ?? (i.url ? extractListingId(i.url) : null);
      if (!id) {
        throw new Error(
          'onehome_get_property_photos: provide either `listing_id` or a portal URL.'
        );
      }
      const groupId =
        i.group_id ?? client.bridgeStatus().sessionContext.groupId;
      if (!groupId) {
        throw new Error(
          'onehome_get_property_photos: no group_id supplied and the MCP ' +
            'did not bootstrap one. Pass one explicitly or run with ONEHOME_MAGIC_LINK.'
        );
      }
      const data = await client.graphql<MediaResponse>(
        buildMediaListingById({ listingId: id, groupId })
      );
      const media = data.listingDetail?.media ?? [];
      const photos = media
        .map(formatPhoto)
        .filter((p): p is FormattedPhoto => p !== null)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      return textResult({
        listing_id: id,
        count: photos.length,
        photos,
      });
    }
  );
}
