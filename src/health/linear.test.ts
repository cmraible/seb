import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LinearHealthChecker } from './linear.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock env.ts to control LINEAR_API_KEY
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

describe('LinearHealthChecker', () => {
  const checker = new LinearHealthChecker();
  const originalEnv = process.env.LINEAR_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.LINEAR_API_KEY = originalEnv;
    } else {
      delete process.env.LINEAR_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it('returns down when no API key is configured', async () => {
    delete process.env.LINEAR_API_KEY;
    const result = await checker.check();
    expect(result.status).toBe('down');
    expect(result.details).toContain('not configured');
  });

  it('returns healthy when viewer query succeeds', async () => {
    process.env.LINEAR_API_KEY = 'test-token';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            id: '123',
            name: 'Seb',
            email: 'seb@example.com',
            active: true,
          },
        },
      }),
    });

    const result = await checker.check();
    expect(result.status).toBe('healthy');
    expect(result.details).toContain('Seb');
  });

  it('returns down when API returns non-OK response', async () => {
    process.env.LINEAR_API_KEY = 'test-token';
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const result = await checker.check();
    expect(result.status).toBe('down');
    expect(result.details).toContain('503');
  });

  it('returns down when viewer data is missing', async () => {
    process.env.LINEAR_API_KEY = 'test-token';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { viewer: null } }),
    });

    const result = await checker.check();
    expect(result.status).toBe('down');
    expect(result.details).toContain('no viewer data');
  });

  it('returns degraded when user is deactivated', async () => {
    process.env.LINEAR_API_KEY = 'test-token';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            id: '123',
            name: 'Seb',
            email: 'seb@example.com',
            active: false,
          },
        },
      }),
    });

    const result = await checker.check();
    expect(result.status).toBe('degraded');
    expect(result.details).toContain('deactivated');
  });

  it('returns down when fetch throws', async () => {
    process.env.LINEAR_API_KEY = 'test-token';
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await checker.check();
    expect(result.status).toBe('down');
    expect(result.details).toContain('Network error');
  });
});
