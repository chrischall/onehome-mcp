import { describe, it, expect } from 'vitest';
import {
  joinNonEmpty,
  streetFromProperty,
  streetFromSuggestion,
} from '../src/address-format.js';

describe('joinNonEmpty', () => {
  it('joins non-empty trimmed parts with the separator', () => {
    expect(joinNonEmpty(['a', 'b', 'c'], ', ')).toBe('a, b, c');
  });

  it('defaults to a space separator', () => {
    expect(joinNonEmpty(['126', 'Bear', 'Ln'])).toBe('126 Bear Ln');
  });

  it('drops undefined / empty / whitespace-only parts', () => {
    expect(joinNonEmpty(['a', undefined, '', '  ', 'b'], ', ')).toBe('a, b');
  });

  it('returns undefined (never an empty string) when nothing survives', () => {
    expect(joinNonEmpty([], ', ')).toBeUndefined();
    expect(joinNonEmpty([undefined, '', '   '])).toBeUndefined();
  });

  it('trims each part', () => {
    expect(joinNonEmpty(['  a  ', ' b '], ', ')).toBe('a, b');
  });
});

describe('streetFromProperty', () => {
  it('joins the capitalized RESO street parts', () => {
    expect(
      streetFromProperty({
        StreetNumber: '126',
        StreetName: 'Sleeping Bear',
        StreetSuffix: 'Lane',
      })
    ).toBe('126 Sleeping Bear Lane');
  });

  it('appends #unit when UnitNumber is set', () => {
    expect(
      streetFromProperty({
        StreetNumber: '155',
        StreetName: 'Quail Cove',
        StreetSuffix: 'Blvd',
        UnitNumber: '1601',
      })
    ).toBe('155 Quail Cove Blvd #1601');
  });

  it('includes direction prefix/suffix', () => {
    expect(
      streetFromProperty({
        StreetNumber: '1',
        StreetDirPrefix: 'N',
        StreetName: 'Main',
        StreetSuffix: 'St',
        StreetDirSuffix: 'W',
      })
    ).toBe('1 N Main St W');
  });

  it('returns undefined when no parts are present', () => {
    expect(streetFromProperty({})).toBeUndefined();
  });
});

describe('streetFromSuggestion', () => {
  it('joins the camelCase suggestion street parts', () => {
    expect(
      streetFromSuggestion({
        streetNumber: '126',
        streetName: 'Sleeping Bear',
        streetSuffix: 'Lane',
      })
    ).toBe('126 Sleeping Bear Lane');
  });

  it('appends #unit when unitNumber is set', () => {
    expect(
      streetFromSuggestion({
        streetNumber: '155',
        streetName: 'Quail Cove',
        streetSuffix: 'Blvd',
        unitNumber: '1601',
      })
    ).toBe('155 Quail Cove Blvd #1601');
  });

  it('returns undefined when no parts are present', () => {
    expect(streetFromSuggestion({})).toBeUndefined();
  });
});
