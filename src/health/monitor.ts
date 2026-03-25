import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type {
  HealthChecker,
  HealthCheckResult,
  HealthState,
  HealthStatus,
} from './types.js';

const DEFAULT_STATE_PATH = path.join(
  process.cwd(),
  'data',
  'health-state.json',
);

export interface AlertSink {
  (message: string): void;
}

export class HealthMonitor {
  private checkers: HealthChecker[] = [];
  private state: HealthState = {};
  private statePath: string;
  private alert: AlertSink;

  constructor(opts: { statePath?: string; alert: AlertSink }) {
    this.statePath = opts.statePath ?? DEFAULT_STATE_PATH;
    this.alert = opts.alert;
    this.loadState();
  }

  register(checker: HealthChecker): void {
    this.checkers.push(checker);
  }

  /** Run all checkers, alert on state transitions, persist state. */
  async runAll(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const checker of this.checkers) {
      try {
        const result = await checker.check();
        results.push(result);
        this.processResult(result);
      } catch (err) {
        logger.error({ err, checker: checker.name }, 'Health checker threw');
        const result: HealthCheckResult = {
          checker: checker.name,
          status: 'down',
          details: `Checker crashed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: new Date().toISOString(),
        };
        results.push(result);
        this.processResult(result);
      }
    }

    this.saveState();
    return results;
  }

  /** Get a summary of current health state. */
  getSummary(): string {
    const entries = Object.entries(this.state);
    if (entries.length === 0) return 'No health checks have run yet.';

    return entries
      .map(([name, s]) => {
        const icon =
          s.status === 'healthy'
            ? '\u2705'
            : s.status === 'degraded'
              ? '\u26a0\ufe0f'
              : '\u274c';
        return `${icon} ${name}: ${s.status}${s.details ? ` — ${s.details}` : ''}`;
      })
      .join('\n');
  }

  /** Get current state (for testing). */
  getState(): HealthState {
    return { ...this.state };
  }

  private processResult(result: HealthCheckResult): void {
    const prev = this.state[result.checker];
    const prevStatus: HealthStatus | undefined = prev?.status;
    const now = result.timestamp;

    // Update state
    this.state[result.checker] = {
      status: result.status,
      details: result.details,
      lastChecked: now,
      lastTransition:
        prevStatus !== result.status ? now : (prev?.lastTransition ?? now),
    };

    // Alert on transitions (skip if no previous state — first run)
    if (prevStatus && prevStatus !== result.status) {
      const direction =
        result.status === 'healthy'
          ? `\u2705 ${result.checker} recovered`
          : `\u26a0\ufe0f ${result.checker} is now ${result.status}`;
      const msg = `${direction}${result.details ? `\n${result.details}` : ''}`;
      logger.info(
        { checker: result.checker, from: prevStatus, to: result.status },
        'Health status transition',
      );
      this.alert(msg);
    }
  }

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      this.state = JSON.parse(raw) as HealthState;
      logger.debug({ path: this.statePath }, 'Loaded health state');
    } catch {
      // No state file yet — start fresh
      this.state = {};
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      logger.warn({ err }, 'Failed to save health state');
    }
  }
}
