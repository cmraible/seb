import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitHubHealthChecker } from './github.js';

// Mock child_process.execFile
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';

const mockExecFile = vi.mocked(execFile);

function setupExecFile(
  responses: Record<
    string,
    { stdout?: string; stderr?: string; code?: number }
  >,
) {
  mockExecFile.mockImplementation(((
    cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: unknown, stdout: string, stderr: string) => void,
  ) => {
    const key = `${cmd} ${args.join(' ')}`;
    // Match by prefix for flexibility
    const match = Object.entries(responses).find(([pattern]) =>
      key.startsWith(pattern),
    );
    const resp = match?.[1] ?? { stdout: '', stderr: '', code: 0 };
    const err = resp.code ? { code: resp.code } : null;
    cb(err, resp.stdout ?? '', resp.stderr ?? '');
  }) as typeof execFile);
}

describe('GitHubHealthChecker', () => {
  const checker = new GitHubHealthChecker();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns down when gh auth fails', async () => {
    setupExecFile({
      'gh auth': { stderr: 'not logged in', code: 1 },
    });

    const result = await checker.check();
    expect(result.status).toBe('down');
    expect(result.details).toContain('auth failed');
  });

  it('returns healthy when all checks pass', async () => {
    setupExecFile({
      'gh auth': { stdout: 'Logged in', code: 0 },
      'gh repo view cmraible/seb': { stdout: '{"name":"seb"}', code: 0 },
      'gh repo view cmraible/sandctl': {
        stdout: '{"name":"sandctl"}',
        code: 0,
      },
      'git -C': {
        stdout: 'https://github.com/seb-writes-code/seb.git',
        code: 0,
      },
    });

    const result = await checker.check();
    expect(result.status).toBe('healthy');
  });

  it('returns degraded when a repo is inaccessible', async () => {
    setupExecFile({
      'gh auth': { stdout: 'Logged in', code: 0 },
      'gh repo view cmraible/seb': { stdout: '{"name":"seb"}', code: 0 },
      'gh repo view cmraible/sandctl': { stderr: 'not found', code: 1 },
      'git -C': {
        stdout: 'https://github.com/seb-writes-code/seb.git',
        code: 0,
      },
    });

    const result = await checker.check();
    expect(result.status).toBe('degraded');
    expect(result.details).toContain('sandctl');
  });

  it('returns degraded when origin points to upstream', async () => {
    setupExecFile({
      'gh auth': { stdout: 'Logged in', code: 0 },
      'gh repo view cmraible/seb': { stdout: '{"name":"seb"}', code: 0 },
      'gh repo view cmraible/sandctl': {
        stdout: '{"name":"sandctl"}',
        code: 0,
      },
      'git -C': {
        stdout: 'https://github.com/qwibitai/nanoclaw.git',
        code: 0,
      },
    });

    const result = await checker.check();
    expect(result.status).toBe('degraded');
    expect(result.details).toContain('qwibitai/nanoclaw');
  });
});
