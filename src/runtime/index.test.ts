import { describe, it, expect } from 'vitest';

// Mock logger (needed by DockerRuntime)
import { vi } from 'vitest';
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process (needed by DockerRuntime)
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import { getRuntime } from './index.js';

describe('getRuntime', () => {
  it('returns a DockerRuntime for "docker" type', () => {
    const runtime = getRuntime('docker');
    expect(runtime.type).toBe('docker');
  });

  it('defaults to docker when no type is specified', () => {
    const runtime = getRuntime();
    expect(runtime.type).toBe('docker');
  });

  it('returns the same cached instance on repeated calls', () => {
    const first = getRuntime('docker');
    const second = getRuntime('docker');
    expect(first).toBe(second);
  });

  it('throws for unimplemented qemu runtime', () => {
    expect(() => getRuntime('qemu')).toThrow(
      'QEMU runtime not yet implemented',
    );
  });

  it('throws for unimplemented cloud runtime', () => {
    expect(() => getRuntime('cloud')).toThrow(
      'Cloud runtime not yet implemented',
    );
  });
});
