import { describe, it, expect } from 'vitest';
import { formatPhoto } from '../../src/tools/photos.js';

describe('formatPhoto', () => {
  it('prefers Large > Medium > Thumbnail for url', () => {
    const p = formatPhoto({
      Order: 5,
      LongDescription: 'Living room facing the lake',
      Image: {
        Thumbnail: { mediaUrl: 'https://cdn/t.jpg', width: 320, height: 240 },
        Medium: { mediaUrl: 'https://cdn/m.jpg', width: 800, height: 600 },
        Large: { mediaUrl: 'https://cdn/l.jpg', width: 1600, height: 1200 },
      },
    });
    expect(p?.url).toBe('https://cdn/l.jpg');
    expect(p?.medium_url).toBe('https://cdn/m.jpg');
    expect(p?.thumbnail_url).toBe('https://cdn/t.jpg');
    expect(p?.width).toBe(1600);
    expect(p?.height).toBe(1200);
    expect(p?.description).toBe('Living room facing the lake');
    expect(p?.order).toBe(5);
  });

  it('falls back to Medium when no Large present', () => {
    const p = formatPhoto({
      Image: {
        Medium: { mediaUrl: 'https://cdn/m.jpg', width: 800, height: 600 },
      },
    });
    expect(p?.url).toBeUndefined();
    expect(p?.medium_url).toBe('https://cdn/m.jpg');
    expect(p?.width).toBe(800);
  });

  it('returns null when no image URLs are present', () => {
    expect(formatPhoto({ Order: 0, Image: {} })).toBeNull();
    expect(formatPhoto({ Order: 0 })).toBeNull();
  });
});
