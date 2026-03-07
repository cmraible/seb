import { describe, it, expect } from 'vitest';
import { parseIntOrDefault } from './config.js';

describe('parseIntOrDefault', () => {
  it('returns parsed integer for valid numeric strings', () => {
    expect(parseIntOrDefault('42', 10)).toBe(42);
    expect(parseIntOrDefault('1800000', 0)).toBe(1800000);
    expect(parseIntOrDefault('0', 5)).toBe(0);
  });

  it('returns fallback for undefined', () => {
    expect(parseIntOrDefault(undefined, 1800000)).toBe(1800000);
  });

  it('returns fallback for empty string', () => {
    expect(parseIntOrDefault('', 1800000)).toBe(1800000);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(parseIntOrDefault('abc', 1800000)).toBe(1800000);
    expect(parseIntOrDefault('not-a-number', 5)).toBe(5);
  });

  it('returns fallback for negative values', () => {
    expect(parseIntOrDefault('-5000', 1800000)).toBe(1800000);
    expect(parseIntOrDefault('-1', 10)).toBe(10);
  });
});
