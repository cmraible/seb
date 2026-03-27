import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthMonitor } from './monitor.js';
import type { HealthChecker, HealthCheckResult } from './types.js';

function makeChecker(
  name: string,
  result: Partial<HealthCheckResult>,
): HealthChecker {
  return {
    name,
    check: vi.fn(async () => ({
      checker: name,
      status: 'healthy' as const,
      timestamp: new Date().toISOString(),
      ...result,
    })),
  };
}

describe('HealthMonitor', () => {
  let tmpDir: string;
  let statePath: string;
  let alerts: string[];
  let alert: (msg: string) => void;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'));
    statePath = path.join(tmpDir, 'health-state.json');
    alerts = [];
    alert = (msg: string) => alerts.push(msg);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runs all registered checkers', async () => {
    const monitor = new HealthMonitor({ statePath, alert });
    const checker1 = makeChecker('a', { status: 'healthy' });
    const checker2 = makeChecker('b', { status: 'healthy' });
    monitor.register(checker1);
    monitor.register(checker2);

    const results = await monitor.runAll();
    expect(results).toHaveLength(2);
    expect(checker1.check).toHaveBeenCalledOnce();
    expect(checker2.check).toHaveBeenCalledOnce();
  });

  it('does not alert on first run (no previous state)', async () => {
    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(
      makeChecker('linear', { status: 'down', details: 'broken' }),
    );

    await monitor.runAll();
    expect(alerts).toHaveLength(0);
  });

  it('alerts on state transition from healthy to degraded', async () => {
    // Seed initial state
    const initialState = {
      linear: {
        status: 'healthy',
        lastChecked: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(initialState));

    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(
      makeChecker('linear', {
        status: 'degraded',
        details: 'Token expiring',
      }),
    );

    await monitor.runAll();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('linear');
    expect(alerts[0]).toContain('degraded');
    expect(alerts[0]).toContain('Token expiring');
  });

  it('alerts on recovery from down to healthy', async () => {
    const initialState = {
      github: {
        status: 'down',
        details: 'auth failed',
        lastChecked: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(initialState));

    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(makeChecker('github', { status: 'healthy' }));

    await monitor.runAll();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('recovered');
  });

  it('does not alert when status stays the same', async () => {
    const initialState = {
      linear: {
        status: 'healthy',
        lastChecked: new Date().toISOString(),
        lastTransition: new Date().toISOString(),
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(initialState));

    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(makeChecker('linear', { status: 'healthy' }));

    await monitor.runAll();
    expect(alerts).toHaveLength(0);
  });

  it('persists state to disk', async () => {
    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(makeChecker('linear', { status: 'healthy' }));

    await monitor.runAll();

    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(persisted.linear).toBeDefined();
    expect(persisted.linear.status).toBe('healthy');
  });

  it('loads persisted state on construction', async () => {
    // First run — seed state
    const monitor1 = new HealthMonitor({ statePath, alert });
    monitor1.register(makeChecker('linear', { status: 'healthy' }));
    await monitor1.runAll();

    // Second run — should load persisted state and detect transition
    const monitor2 = new HealthMonitor({ statePath, alert });
    monitor2.register(
      makeChecker('linear', { status: 'down', details: 'oops' }),
    );
    await monitor2.runAll();

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('down');
  });

  it('handles checker that throws', async () => {
    const monitor = new HealthMonitor({ statePath, alert });
    const broken: HealthChecker = {
      name: 'broken',
      check: vi.fn(async () => {
        throw new Error('kaboom');
      }),
    };
    monitor.register(broken);

    const results = await monitor.runAll();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('down');
    expect(results[0].details).toContain('kaboom');
  });

  it('getSummary returns formatted status', async () => {
    const monitor = new HealthMonitor({ statePath, alert });
    monitor.register(
      makeChecker('linear', { status: 'healthy', details: 'OK' }),
    );
    monitor.register(
      makeChecker('github', { status: 'degraded', details: 'repo issue' }),
    );

    await monitor.runAll();
    const summary = monitor.getSummary();

    expect(summary).toContain('linear');
    expect(summary).toContain('github');
    expect(summary).toContain('healthy');
    expect(summary).toContain('degraded');
  });

  it('getSummary returns message when no checks have run', () => {
    const monitor = new HealthMonitor({ statePath, alert });
    expect(monitor.getSummary()).toContain('No health checks');
  });
});
