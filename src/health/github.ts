import { execFile } from 'child_process';
import { logger } from '../logger.js';
import type { HealthChecker, HealthCheckResult } from './types.js';

/** Run a shell command and return { stdout, stderr, exitCode }. */
function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      const exitCode =
        err && 'code' in err ? (err.code as number) : err ? 1 : 0;
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
    });
  });
}

const EXPECTED_REPOS = ['cmraible/seb', 'cmraible/sandctl'];

export class GitHubHealthChecker implements HealthChecker {
  name = 'github';

  async check(): Promise<HealthCheckResult> {
    const timestamp = new Date().toISOString();
    const issues: string[] = [];

    // 1. Check gh auth status
    const auth = await run('gh', ['auth', 'status']);
    if (auth.exitCode !== 0) {
      return {
        checker: this.name,
        status: 'down',
        details: `gh auth failed: ${auth.stderr.trim()}`,
        timestamp,
      };
    }

    // 2. Check repo access
    for (const repo of EXPECTED_REPOS) {
      const repoCheck = await run('gh', [
        'repo',
        'view',
        repo,
        '--json',
        'name',
      ]);
      if (repoCheck.exitCode !== 0) {
        issues.push(`Cannot access ${repo}`);
      }
    }

    // 3. Check fork remote is correctly configured
    const remoteCheck = await run('git', [
      '-C',
      process.cwd(),
      'remote',
      'get-url',
      'origin',
    ]);
    if (remoteCheck.exitCode === 0) {
      const originUrl = remoteCheck.stdout.trim();
      if (
        originUrl.includes('qwibitai/nanoclaw') ||
        originUrl.includes('cmraible/seb')
      ) {
        issues.push(
          `origin remote points to ${originUrl} instead of seb-writes-code fork`,
        );
      }
    }

    if (issues.length > 0) {
      logger.warn({ issues }, 'GitHub health check found issues');
      return {
        checker: this.name,
        status: 'degraded',
        details: issues.join('; '),
        timestamp,
      };
    }

    return {
      checker: this.name,
      status: 'healthy',
      details: 'gh auth OK, repos accessible, fork remote correct',
      timestamp,
    };
  }
}
