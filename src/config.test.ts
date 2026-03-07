import { describe, it, expect } from 'vitest';
import { safeParseInt } from './config.js';

describe('safeParseInt', () => {
  it('parses valid integer strings', () => {
    expect(safeParseInt('42', 0)).toBe(42);
    expect(safeParseInt('1800000', 0)).toBe(1800000);
  });

  it('returns fallback for undefined', () => {
    expect(safeParseInt(undefined, 99)).toBe(99);
  });

  it('returns fallback for empty string', () => {
    expect(safeParseInt('', 99)).toBe(99);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(safeParseInt('abc', 5)).toBe(5);
    expect(safeParseInt('not-a-number', 10)).toBe(10);
  });

  it('parses strings with trailing non-numeric chars (parseInt behavior)', () => {
    // parseInt('123abc') returns 123 — this is expected JS behavior
    expect(safeParseInt('123abc', 0)).toBe(123);
  });

  it('handles negative numbers', () => {
    expect(safeParseInt('-1', 0)).toBe(-1);
  });

  it('handles zero', () => {
    expect(safeParseInt('0', 99)).toBe(0);
  });
});
