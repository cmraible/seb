import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  getBackoffMultiplier,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

/** Helper to create a full ScheduledTask with sensible defaults */
function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'test-task',
    group_folder: 'test',
    chat_jid: 'test@g.us',
    prompt: 'test',
    schedule_type: 'interval',
    schedule_value: '60000',
    context_mode: 'isolated',
    next_run: new Date().toISOString(),
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    consecutive_silent_runs: 0,
    auto_backoff: false,
    ...overrides,
  };
}

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = makeTask({
      id: 'drift-test',
      schedule_type: 'interval',
      schedule_value: '60000',
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = makeTask({
      id: 'once-test',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      next_run: new Date(Date.now() - 1000).toISOString(),
    });

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun falls back to 60s for invalid interval values', () => {
    const baseTask = makeTask({
      id: 'invalid-interval',
      schedule_type: 'interval',
    });

    const now = Date.now();

    // Zero interval would cause infinite while-loop without the guard
    const zeroResult = computeNextRun({ ...baseTask, schedule_value: '0' });
    expect(zeroResult).not.toBeNull();
    expect(new Date(zeroResult!).getTime()).toBeGreaterThanOrEqual(
      now + 60_000,
    );

    // Negative interval
    const negResult = computeNextRun({ ...baseTask, schedule_value: '-5000' });
    expect(negResult).not.toBeNull();
    expect(new Date(negResult!).getTime()).toBeGreaterThanOrEqual(now + 60_000);

    // Non-numeric string
    const nanResult = computeNextRun({ ...baseTask, schedule_value: 'abc' });
    expect(nanResult).not.toBeNull();
    expect(new Date(nanResult!).getTime()).toBeGreaterThanOrEqual(now + 60_000);
  });

  it('computeNextRun returns null for invalid cron expressions instead of throwing', () => {
    const task = makeTask({
      id: 'bad-cron',
      schedule_type: 'cron',
      schedule_value: 'not a valid cron',
    });

    // Should return null instead of throwing, preventing tasks from
    // getting stuck in 'running' status when cron parsing fails
    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = makeTask({
      id: 'skip-test',
      schedule_type: 'interval',
      schedule_value: String(ms),
      next_run: scheduledTime,
    });

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('computeNextRun falls back to now + interval when next_run is null', () => {
    const ms = 60000;
    const task = makeTask({
      id: 'null-next-run',
      schedule_type: 'interval',
      schedule_value: String(ms),
      next_run: null,
    });

    const before = Date.now();
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    const nextMs = new Date(nextRun!).getTime();
    // Should be approximately now + interval
    expect(nextMs).toBeGreaterThanOrEqual(before + ms);
    expect(nextMs).toBeLessThanOrEqual(Date.now() + ms + 1000);
  });

  // --- Auto-backoff tests ---

  describe('auto-backoff', () => {
    it('getBackoffMultiplier returns 1 when auto_backoff is disabled', () => {
      const task = makeTask({
        auto_backoff: false,
        consecutive_silent_runs: 5,
      });
      expect(getBackoffMultiplier(task)).toBe(1);
    });

    it('getBackoffMultiplier returns 1 when no silent runs', () => {
      const task = makeTask({
        auto_backoff: true,
        consecutive_silent_runs: 0,
      });
      expect(getBackoffMultiplier(task)).toBe(1);
    });

    it('getBackoffMultiplier applies exponential backoff', () => {
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 1 }),
        ),
      ).toBe(2);
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 2 }),
        ),
      ).toBe(4);
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 3 }),
        ),
      ).toBe(8);
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 4 }),
        ),
      ).toBe(16);
    });

    it('getBackoffMultiplier caps at 2^4 = 16', () => {
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 5 }),
        ),
      ).toBe(16);
      expect(
        getBackoffMultiplier(
          makeTask({ auto_backoff: true, consecutive_silent_runs: 100 }),
        ),
      ).toBe(16);
    });

    it('computeNextRun applies backoff to interval tasks', () => {
      const ms = 1800000; // 30 minutes
      const task = makeTask({
        schedule_type: 'interval',
        schedule_value: String(ms),
        auto_backoff: true,
        consecutive_silent_runs: 2, // 4x multiplier
        next_run: null,
      });

      const before = Date.now();
      const nextRun = computeNextRun(task);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      // Should be approximately now + 30min * 4 = 2 hours
      expect(nextMs).toBeGreaterThanOrEqual(before + ms * 4);
      expect(nextMs).toBeLessThanOrEqual(Date.now() + ms * 4 + 1000);
    });

    it('computeNextRun caps interval backoff at 16x base', () => {
      const ms = 1800000; // 30 minutes
      const task = makeTask({
        schedule_type: 'interval',
        schedule_value: String(ms),
        auto_backoff: true,
        consecutive_silent_runs: 10, // Would be 1024x without cap
        next_run: null,
      });

      const before = Date.now();
      const nextRun = computeNextRun(task);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      // Should be capped at 16x = 8 hours
      expect(nextMs).toBeGreaterThanOrEqual(before + ms * 16);
      expect(nextMs).toBeLessThanOrEqual(Date.now() + ms * 16 + 1000);
    });

    it('computeNextRun does not apply backoff when auto_backoff is false', () => {
      const ms = 60000;
      const task = makeTask({
        schedule_type: 'interval',
        schedule_value: String(ms),
        auto_backoff: false,
        consecutive_silent_runs: 10,
        next_run: null,
      });

      const before = Date.now();
      const nextRun = computeNextRun(task);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      // Should be approximately now + base interval, no backoff
      expect(nextMs).toBeGreaterThanOrEqual(before + ms);
      expect(nextMs).toBeLessThanOrEqual(Date.now() + ms + 1000);
    });

    it('computeNextRun applies backoff to cron tasks', () => {
      // Use a cron expression that fires every 30 minutes
      const task = makeTask({
        schedule_type: 'cron',
        schedule_value: '*/30 * * * *',
        auto_backoff: true,
        consecutive_silent_runs: 2, // 4x multiplier
      });

      const nextRun = computeNextRun(task);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      const now = Date.now();
      // With 4x backoff on a 30-min cron, effective delay is 2 hours
      // The next run should be at least 2 hours from now
      expect(nextMs).toBeGreaterThanOrEqual(now + 30 * 60 * 1000 * 4 - 60_000);
    });

    it('computeNextRun caps cron backoff at 4 hours', () => {
      // Use a cron expression that fires every 30 minutes
      const task = makeTask({
        schedule_type: 'cron',
        schedule_value: '*/30 * * * *',
        auto_backoff: true,
        consecutive_silent_runs: 10, // Would be huge without cap
      });

      const nextRun = computeNextRun(task);
      expect(nextRun).not.toBeNull();
      const nextMs = new Date(nextRun!).getTime();
      const now = Date.now();
      // Should be capped at 4 hours from now
      const fourHoursMs = 4 * 60 * 60 * 1000;
      expect(nextMs).toBeLessThanOrEqual(now + fourHoursMs + 60_000);
    });

    it('consecutive_silent_runs persists through DB round-trip', () => {
      _initTestDatabase();
      createTask({
        id: 'backoff-db-test',
        group_folder: 'test',
        chat_jid: 'test@g.us',
        prompt: 'test',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: new Date().toISOString(),
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        auto_backoff: true,
      });

      const task = getTaskById('backoff-db-test');
      expect(task).toBeDefined();
      expect(task!.consecutive_silent_runs).toBe(0);
      expect(task!.auto_backoff).toBeTruthy();
    });
  });
});
