import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import { DockerRuntime } from './docker.js';
import { logger } from '../logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- readonlyMountArgs ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const runtime = new DockerRuntime();
    const args = runtime.readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

// --- stopCommand ---

describe('stopCommand', () => {
  it('returns docker stop command with container name', () => {
    const runtime = new DockerRuntime();
    expect(runtime.stopCommand('nanoclaw-test-123')).toBe(
      'docker stop nanoclaw-test-123',
    );
  });
});

// --- ensureRunning ---

describe('ensureRunning', () => {
  it('does nothing when runtime is already running', () => {
    const runtime = new DockerRuntime();
    mockExecSync.mockReturnValueOnce('');

    runtime.ensureRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    const runtime = new DockerRuntime();
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => runtime.ensureRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    const runtime = new DockerRuntime();
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    runtime.cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'docker stop nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'docker stop nanoclaw-group2-222',
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    const runtime = new DockerRuntime();
    mockExecSync.mockReturnValueOnce('');

    runtime.cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    const runtime = new DockerRuntime();
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    runtime.cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const runtime = new DockerRuntime();
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    runtime.cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- type ---

describe('DockerRuntime type', () => {
  it('has type "docker"', () => {
    const runtime = new DockerRuntime();
    expect(runtime.type).toBe('docker');
  });
});
