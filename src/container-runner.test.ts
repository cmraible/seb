import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

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
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake RuntimeInstance backed by EventEmitter + streams
import { PassThrough } from 'stream';
import fs from 'fs';
import type { RuntimeInstance } from './runtime/runtime.js';

function createFakeInstance(): RuntimeInstance & {
  _stdout: PassThrough;
  _stderr: PassThrough;
  _emitter: EventEmitter;
  _stdinData: string[];
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdinData: string[] = [];

  return {
    name: 'nanoclaw-test-123',
    _stdout: stdout,
    _stderr: stderr,
    _emitter: emitter,
    _stdinData: stdinData,
    writeInput(data: string) {
      stdinData.push(data);
    },
    closeInput() {
      /* no-op */
    },
    kill: vi.fn(),
    onStdout(handler: (data: Buffer) => void) {
      stdout.on('data', handler);
    },
    onStderr(handler: (data: Buffer) => void) {
      stderr.on('data', handler);
    },
    onClose(handler: (code: number | null) => void) {
      emitter.on('close', handler);
    },
    onError(handler: (err: Error) => void) {
      emitter.on('error', handler);
    },
    async stop() {
      /* no-op */
    },
  };
}

let fakeInstance: ReturnType<typeof createFakeInstance>;

// Mock the runtime module
vi.mock('./runtime/index.js', () => ({
  getRuntime: vi.fn(() => ({
    type: 'docker',
    ensureRunning: vi.fn(),
    cleanupOrphans: vi.fn(),
    stopCommand: (name: string) => `docker stop ${name}`,
    start: vi.fn(async () => fakeInstance),
  })),
}));

// Mock child_process.exec (used for timeout stop command)
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  writeLogsSnapshot,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import type { TaskRunLogEntry } from './container-runner.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  instance: ReturnType<typeof createFakeInstance>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  instance._stdout.push(
    `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
  );
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeInstance = createFakeInstance();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeInstance._emitter.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeInstance._emitter.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('onOutput error does not hang the promise', async () => {
    const onOutput = vi.fn(async () => {
      throw new Error('sendMessage failed');
    });
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output — onOutput will throw
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Agent response',
      newSessionId: 'session-err',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit
    fakeInstance._emitter.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    // The promise should still resolve (not hang)
    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(onOutput).toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeInstance, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeInstance._emitter.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

// --- writeLogsSnapshot ---

describe('writeLogsSnapshot', () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    mockFs.mkdirSync.mockClear();
    mockFs.writeFileSync.mockClear();
    mockFs.existsSync.mockReturnValue(false);
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  const sampleTaskLogs: TaskRunLogEntry[] = [
    {
      task_id: 'task-1',
      run_at: '2024-06-01T00:00:00.000Z',
      duration_ms: 100,
      status: 'success',
      error: null,
      group_folder: 'test-group',
    },
  ];

  it('creates IPC directory and writes snapshot file', () => {
    writeLogsSnapshot('test-group', false, sampleTaskLogs, ['test-group']);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('test-group'),
      { recursive: true },
    );
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();

    const writtenPath = vi.mocked(mockFs.writeFileSync).mock.calls[0][0];
    expect(String(writtenPath)).toContain('recent_logs.json');
  });

  it('includes task_runs in snapshot JSON', () => {
    writeLogsSnapshot('test-group', false, sampleTaskLogs, ['test-group']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenData.task_runs).toHaveLength(1);
    expect(writtenData.task_runs[0].task_id).toBe('task-1');
    expect(writtenData.generated_at).toBeDefined();
  });

  it('returns empty container_runs when no log directory exists', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(false);

    writeLogsSnapshot('test-group', false, [], ['test-group']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenData.container_runs).toHaveLength(0);
  });

  it('parses container log files when log directory exists', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(true);
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      'container-2024-06-01.log',
    ]);
    vi.mocked(mockFs.readFileSync).mockReturnValue(
      [
        'Timestamp: 2024-06-01T00:00:00.000Z',
        'Duration: 1500',
        'Exit Code: 0',
        'Group: test-group',
      ].join('\n'),
    );

    writeLogsSnapshot('test-group', false, [], ['test-group']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenData.container_runs).toHaveLength(1);
    expect(writtenData.container_runs[0]).toEqual({
      timestamp: '2024-06-01T00:00:00.000Z',
      duration_ms: 1500,
      exit_code: 0,
      group: 'test-group',
      stderr_preview: null,
    });
  });

  it('extracts stderr preview for non-zero exit codes', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(true);
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      'container-2024-06-01.log',
    ]);
    vi.mocked(mockFs.readFileSync).mockReturnValue(
      [
        'Timestamp: 2024-06-01T00:00:00.000Z',
        'Duration: 500',
        'Exit Code: 1',
        'Group: test-group',
        '=== Stderr ===',
        'Error: something went wrong',
        '=== End ===',
      ].join('\n'),
    );

    writeLogsSnapshot('test-group', false, [], ['test-group']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenData.container_runs[0].stderr_preview).toBe(
      'Error: something went wrong',
    );
  });

  it('does not extract stderr for zero exit codes', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(true);
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      'container-2024-06-01.log',
    ]);
    vi.mocked(mockFs.readFileSync).mockReturnValue(
      [
        'Timestamp: 2024-06-01T00:00:00.000Z',
        'Duration: 500',
        'Exit Code: 0',
        'Group: test-group',
        '=== Stderr ===',
        'Some warning output',
      ].join('\n'),
    );

    writeLogsSnapshot('test-group', false, [], ['test-group']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    expect(writtenData.container_runs[0].stderr_preview).toBeNull();
  });

  it('main group aggregates logs from all groups', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(true);

    // Return different files per directory call
    let callCount = 0;
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      return [`container-run-${callCount}.log`];
    });

    vi.mocked(mockFs.readFileSync).mockImplementation((filePath) => {
      const p = String(filePath);
      if (p.includes('run-1')) {
        return 'Timestamp: 2024-06-01T00:01:00.000Z\nDuration: 100\nExit Code: 0\nGroup: group-a';
      }
      return 'Timestamp: 2024-06-01T00:02:00.000Z\nDuration: 200\nExit Code: 0\nGroup: group-b';
    });

    writeLogsSnapshot('main-group', true, [], ['group-a', 'group-b']);

    const writtenData = JSON.parse(
      vi.mocked(mockFs.writeFileSync).mock.calls[0][1] as string,
    );
    // Main group should see runs from both groups
    expect(writtenData.container_runs).toHaveLength(2);
    // Sorted by timestamp descending
    expect(writtenData.container_runs[0].group).toBe('group-b');
    expect(writtenData.container_runs[1].group).toBe('group-a');
  });

  it('non-main group sees only its own logs', () => {
    vi.mocked(mockFs.existsSync).mockReturnValue(true);
    vi.mocked(mockFs.readFileSync).mockReturnValue(
      'Timestamp: 2024-06-01T00:00:00.000Z\nDuration: 100\nExit Code: 0\nGroup: my-group',
    );

    // Clear then set return value to count only calls from this invocation
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockClear();
    (mockFs.readdirSync as ReturnType<typeof vi.fn>).mockReturnValue([
      'container-2024-06-01.log',
    ]);

    writeLogsSnapshot('my-group', false, [], ['my-group', 'other-group']);

    // readdirSync should only be called for my-group's logs dir, not other-group's
    const readdirCalls = vi
      .mocked(mockFs.readdirSync)
      .mock.calls.map((c) => String(c[0]));
    expect(readdirCalls).toHaveLength(1);
    expect(readdirCalls[0]).toContain('my-group');
  });
});
