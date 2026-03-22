import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process
const mockExecSync = vi.fn();
const mockSpawn = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  spawn: (...args: any[]) => mockSpawn(...args),
}));

// Mock os.platform
const mockPlatform = vi.fn(() => 'darwin');
vi.mock('os', () => ({
  default: { platform: () => mockPlatform() },
  platform: () => mockPlatform(),
}));

import { DockerRuntime } from './docker.js';

function createFakeProc() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    pid: 12345,
  });
}

describe('DockerRuntime', () => {
  let runtime: DockerRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new DockerRuntime();
  });

  describe('type', () => {
    it('has type "docker"', () => {
      expect(runtime.type).toBe('docker');
    });
  });

  describe('ensureRunning', () => {
    it('succeeds when docker info works', () => {
      mockExecSync.mockReturnValue(Buffer.from(''));
      expect(() => runtime.ensureRunning()).not.toThrow();
      expect(mockExecSync).toHaveBeenCalledWith('docker info', {
        stdio: 'pipe',
        timeout: 10000,
      });
    });

    it('throws when docker info fails', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('docker not found');
      });
      expect(() => runtime.ensureRunning()).toThrow(
        'Container runtime is required but failed to start',
      );
    });
  });

  describe('cleanupOrphans', () => {
    it('stops orphaned containers', () => {
      mockExecSync
        .mockReturnValueOnce('nanoclaw-abc\nnanoclaw-def\n')
        .mockReturnValueOnce('')
        .mockReturnValueOnce('');

      runtime.cleanupOrphans();

      expect(mockExecSync).toHaveBeenCalledTimes(3);
      expect(mockExecSync).toHaveBeenCalledWith('docker stop nanoclaw-abc', {
        stdio: 'pipe',
      });
      expect(mockExecSync).toHaveBeenCalledWith('docker stop nanoclaw-def', {
        stdio: 'pipe',
      });
    });

    it('does nothing when no orphans exist', () => {
      mockExecSync.mockReturnValueOnce('');

      runtime.cleanupOrphans();

      // Only the ps command, no stop commands
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it('ignores errors when stopping individual containers', () => {
      mockExecSync
        .mockReturnValueOnce('nanoclaw-abc\n')
        .mockImplementationOnce(() => {
          throw new Error('already stopped');
        });

      // Should not throw
      expect(() => runtime.cleanupOrphans()).not.toThrow();
    });

    it('handles docker ps failure gracefully', () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('docker daemon not running');
      });

      // Should not throw
      expect(() => runtime.cleanupOrphans()).not.toThrow();
    });
  });

  describe('stopCommand', () => {
    it('returns docker stop command for the given name', () => {
      expect(runtime.stopCommand('nanoclaw-test-1')).toBe(
        'docker stop nanoclaw-test-1',
      );
    });
  });

  describe('readonlyMountArgs', () => {
    it('returns readonly bind mount arguments', () => {
      expect(
        runtime.readonlyMountArgs('/host/path', '/container/path'),
      ).toEqual(['-v', '/host/path:/container/path:ro']);
    });
  });

  describe('start', () => {
    it('spawns a docker container with correct arguments', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start(
        'nanoclaw-test-1',
        [
          {
            hostPath: '/data/group',
            containerPath: '/workspace/group',
            readonly: false,
          },
          {
            hostPath: '/config/settings',
            containerPath: '/config',
            readonly: true,
          },
        ],
        { FOO: 'bar', BAZ: 'qux' },
        { image: 'my-agent:v2' },
      );

      expect(mockSpawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run',
          '-i',
          '--rm',
          '--name',
          'nanoclaw-test-1',
          '-e',
          'FOO=bar',
          '-e',
          'BAZ=qux',
          '-v',
          '/data/group:/workspace/group',
          '-v',
          '/config/settings:/config:ro',
          'my-agent:v2',
        ]),
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      expect(instance.name).toBe('nanoclaw-test-1');
    });

    it('uses default image when none specified', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      await runtime.start('nanoclaw-test-1', [], {}, {});

      const args = mockSpawn.mock.calls[0][1];
      expect(args[args.length - 1]).toBe('nanoclaw-agent:latest');
    });

    it('maps host UID/GID and sets HOME', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const env: Record<string, string> = {
        _NANOCLAW_HOST_UID: '1000',
        _NANOCLAW_HOST_GID: '1000',
        OTHER: 'val',
      };

      await runtime.start('nanoclaw-test-1', [], env, {});

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--user');
      const userIdx = args.indexOf('--user');
      expect(args[userIdx + 1]).toBe('1000:1000');
      // Internal env vars should be stripped
      expect(args.join(' ')).not.toContain('_NANOCLAW_HOST_UID');
      expect(args.join(' ')).not.toContain('_NANOCLAW_HOST_GID');
      // HOME should be set
      expect(args).toContain('HOME=/home/node');
    });

    it('adds host.docker.internal on Linux', async () => {
      mockPlatform.mockReturnValue('linux');
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      await runtime.start('nanoclaw-test-1', [], {}, {});

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    });

    it('does not add host.docker.internal on macOS', async () => {
      mockPlatform.mockReturnValue('darwin');
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      await runtime.start('nanoclaw-test-1', [], {}, {});

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain(
        '--add-host=host.docker.internal:host-gateway',
      );
    });
  });

  describe('DockerInstance', () => {
    it('delegates writeInput to stdin', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);
      const writeSpy = vi.spyOn(fakeProc.stdin, 'write');

      const instance = await runtime.start('test', [], {}, {});
      instance.writeInput('hello\n');

      expect(writeSpy).toHaveBeenCalledWith('hello\n');
    });

    it('delegates closeInput to stdin.end', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);
      const endSpy = vi.spyOn(fakeProc.stdin, 'end');

      const instance = await runtime.start('test', [], {}, {});
      instance.closeInput();

      expect(endSpy).toHaveBeenCalled();
    });

    it('delegates kill to proc.kill', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('test', [], {}, {});
      instance.kill('SIGTERM');

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('receives stdout data via onStdout', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('test', [], {}, {});
      const chunks: Buffer[] = [];
      instance.onStdout((data) => chunks.push(data));

      fakeProc.stdout.push(Buffer.from('output'));
      fakeProc.stdout.push(null);

      // Allow event loop to flush
      await new Promise((r) => setTimeout(r, 10));
      expect(Buffer.concat(chunks).toString()).toBe('output');
    });

    it('receives stderr data via onStderr', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('test', [], {}, {});
      const chunks: Buffer[] = [];
      instance.onStderr((data) => chunks.push(data));

      fakeProc.stderr.push(Buffer.from('error'));
      fakeProc.stderr.push(null);

      await new Promise((r) => setTimeout(r, 10));
      expect(Buffer.concat(chunks).toString()).toBe('error');
    });

    it('receives close event via onClose', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('test', [], {}, {});
      const codes: (number | null)[] = [];
      instance.onClose((code) => codes.push(code));

      fakeProc.emit('close', 0);

      expect(codes).toEqual([0]);
    });

    it('receives error event via onError', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('test', [], {}, {});
      const errors: Error[] = [];
      instance.onError((err) => errors.push(err));

      const testErr = new Error('spawn failed');
      fakeProc.emit('error', testErr);

      expect(errors).toEqual([testErr]);
    });

    it('stop() calls docker stop, falls back to SIGKILL on failure', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('nanoclaw-test-1', [], {}, {});

      // First call (docker stop) fails
      mockExecSync.mockImplementation(() => {
        throw new Error('timeout');
      });

      await instance.stop();

      expect(mockExecSync).toHaveBeenCalledWith('docker stop nanoclaw-test-1', {
        stdio: 'pipe',
        timeout: 15000,
      });
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('stop() succeeds without SIGKILL when docker stop works', async () => {
      const fakeProc = createFakeProc();
      mockSpawn.mockReturnValue(fakeProc);

      const instance = await runtime.start('nanoclaw-test-1', [], {}, {});

      mockExecSync.mockReturnValue('');

      await instance.stop();

      expect(mockExecSync).toHaveBeenCalledWith('docker stop nanoclaw-test-1', {
        stdio: 'pipe',
        timeout: 15000,
      });
      expect(fakeProc.kill).not.toHaveBeenCalled();
    });
  });
});
