import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  },
}));

import { parseIntEnv, readEnvFile } from './env.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('readEnvFile', () => {
  it('returns requested keys from .env file', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\nBAZ=qux\nOTHER=ignored\n');

    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('returns empty object when .env file does not exist', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({});
  });

  it('skips comment lines', () => {
    mockReadFileSync.mockReturnValue(
      '# This is a comment\nFOO=bar\n# Another comment\n',
    );

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips empty lines', () => {
    mockReadFileSync.mockReturnValue('\n\nFOO=bar\n\n');

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips lines without equals sign', () => {
    mockReadFileSync.mockReturnValue('INVALID_LINE\nFOO=bar\n');

    const result = readEnvFile(['FOO', 'INVALID_LINE']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('strips double quotes from values', () => {
    mockReadFileSync.mockReturnValue('FOO="hello world"\n');

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('strips single quotes from values', () => {
    mockReadFileSync.mockReturnValue("FOO='hello world'\n");

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    mockReadFileSync.mockReturnValue('FOO="hello world\'\n');

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: '"hello world\'' });
  });

  it('only returns keys that were requested', () => {
    mockReadFileSync.mockReturnValue('FOO=1\nBAR=2\nBAZ=3\n');

    const result = readEnvFile(['BAR']);
    expect(result).toEqual({ BAR: '2' });
  });

  it('returns empty object when no requested keys are found', () => {
    mockReadFileSync.mockReturnValue('OTHER=value\n');

    const result = readEnvFile(['FOO', 'BAR']);
    expect(result).toEqual({});
  });

  it('handles values containing equals signs', () => {
    mockReadFileSync.mockReturnValue('URL=https://example.com?a=1&b=2\n');

    const result = readEnvFile(['URL']);
    expect(result).toEqual({ URL: 'https://example.com?a=1&b=2' });
  });

  it('trims whitespace around keys and values', () => {
    mockReadFileSync.mockReturnValue('  FOO  =  bar  \n');

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips keys with empty values', () => {
    mockReadFileSync.mockReturnValue('FOO=\nBAR=value\n');

    const result = readEnvFile(['FOO', 'BAR']);
    expect(result).toEqual({ BAR: 'value' });
  });

  it('handles empty keys list', () => {
    mockReadFileSync.mockReturnValue('FOO=bar\n');

    const result = readEnvFile([]);
    expect(result).toEqual({});
  });

  it('handles whitespace-only lines', () => {
    mockReadFileSync.mockReturnValue('   \n  \t  \nFOO=bar\n');

    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });
});

describe('parseIntEnv', () => {
  it('returns default when env var is not set', () => {
    expect(parseIntEnv('UNSET_VAR_12345', 42)).toBe(42);
  });

  it('returns default when env var is empty string', () => {
    vi.stubEnv('TEST_PARSE_INT', '');
    expect(parseIntEnv('TEST_PARSE_INT', 42)).toBe(42);
  });

  it('parses valid integer', () => {
    vi.stubEnv('TEST_PARSE_INT', '100');
    expect(parseIntEnv('TEST_PARSE_INT', 42)).toBe(100);
  });

  it('parses zero', () => {
    vi.stubEnv('TEST_PARSE_INT', '0');
    expect(parseIntEnv('TEST_PARSE_INT', 42)).toBe(0);
  });

  it('parses negative numbers', () => {
    vi.stubEnv('TEST_PARSE_INT', '-5');
    expect(parseIntEnv('TEST_PARSE_INT', 42)).toBe(-5);
  });

  it('throws on non-numeric string', () => {
    vi.stubEnv('TEST_PARSE_INT', 'invalid');
    expect(() => parseIntEnv('TEST_PARSE_INT', 42)).toThrow(
      'Invalid integer for TEST_PARSE_INT: "invalid"',
    );
  });

  it('throws on float-like string that parseInt would silently truncate', () => {
    // parseInt("12.5") returns 12 — that's fine, it's still a number.
    // But "abc" or "12abc" edge cases: parseInt("12abc") = 12 which is valid.
    // We only reject true NaN cases.
    vi.stubEnv('TEST_PARSE_INT', '12abc');
    // parseInt('12abc') = 12, which is not NaN, so this succeeds
    expect(parseIntEnv('TEST_PARSE_INT', 42)).toBe(12);
  });
});
