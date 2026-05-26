import { describe, it, expect } from 'vitest';
import { extractListingId } from '../src/url.js';

describe('extractListingId', () => {
  it('returns a bare id unchanged', () => {
    expect(extractListingId('EYxOzZSAbCdEf12345')).toBe('EYxOzZSAbCdEf12345');
  });

  it('parses a full portal URL', () => {
    expect(
      extractListingId(
        'https://portal.onehome.com/en-US/properties/EYxOzZSAbCdEf12345'
      )
    ).toBe('EYxOzZSAbCdEf12345');
  });

  it('parses /en-US/property/<id>', () => {
    expect(
      extractListingId('https://portal.onehome.com/en-US/property/AbCd1234XY')
    ).toBe('AbCd1234XY');
  });

  it('strips query and hash', () => {
    expect(
      extractListingId(
        'https://portal.onehome.com/en-US/properties/AbCd1234XY?token=foo#section'
      )
    ).toBe('AbCd1234XY');
  });

  it('returns null on /properties (no id)', () => {
    expect(
      extractListingId('https://portal.onehome.com/en-US/properties')
    ).toBeNull();
  });

  it('returns null on /properties/map', () => {
    expect(
      extractListingId('https://portal.onehome.com/en-US/properties/map')
    ).toBeNull();
  });

  it('returns null on too-short bare input', () => {
    expect(extractListingId('abc')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(extractListingId('')).toBeNull();
    expect(extractListingId('   ')).toBeNull();
  });
});
