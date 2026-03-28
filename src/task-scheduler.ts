import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import path from 'path';
import { logger } from './logger.js';
import { ChildProcess } from 'child_process';
import { RegisteredGroup, ScheduledTask } from './types.js';

/** Maximum backoff power — 2^4 = 16x multiplier */
const MAX_BACKOFF_POWER = 4;
/** Maximum backoff interval for cron tasks: 4 hours */
const MAX_BACKOFF_CRON_MS = 4 * 60 * 60 * 1000;
/** Maximum backoff multiplier for interval tasks */
const MAX_BACKOFF_INTERVAL_MULTIPLIER = 16;

/**
 * Calculate the backoff multiplier for a task based on consecutive silent runs.
 * Returns 1 (no backoff) if auto_backoff is disabled or no silent runs.
 */
export function getBackoffMultiplier(task: ScheduledTask): number {
  if (!task.auto_backoff || !task.consecutive_silent_runs) return 1;
  return Math.pow(2, Math.min(task.consecutive_silent_runs, MAX_BACKOFF_POWER));
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * When auto_backoff is enabled and the task has consecutive silent runs,
 * the effective interval is multiplied by 2^min(silent_runs, 4).
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();
  const backoffMultiplier = getBackoffMultiplier(task);

  if (task.schedule_type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(task.schedule_value, {
        tz: TIMEZONE,
      });
      const naturalNext = interval.next().toISOString();
      if (!naturalNext) return null;

      if (backoffMultiplier <= 1) return naturalNext;

      // For cron tasks, compute the base interval from consecutive cron ticks
      const nextTime = new Date(naturalNext).getTime();
      const secondNext = interval.next().toISOString();
      if (!secondNext) return naturalNext; // fallback to natural
      const baseInterval = new Date(secondNext).getTime() - nextTime;

      const backoffDelay = Math.min(
        baseInterval * backoffMultiplier,
        MAX_BACKOFF_CRON_MS,
      );
      const backedOffTime = new Date(
        Math.max(nextTime, now + backoffDelay),
      ).toISOString();
      return backedOffTime;
    } catch {
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid cron expression, cannot compute next run',
      );
      return null;
    }
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }

    // Apply backoff: multiply effective interval, capped at 16x base
    const effectiveMs =
      backoffMultiplier > 1
        ? Math.min(ms * backoffMultiplier, ms * MAX_BACKOFF_INTERVAL_MULTIPLIER)
        : ms;

    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    const anchor = task.next_run ? new Date(task.next_run).getTime() : NaN;
    if (!anchor || anchor <= 0) {
      // next_run is null or invalid — fall back to now + interval
      return new Date(now + effectiveMs).toISOString();
    }
    let next = anchor + effectiveMs;
    while (next <= now) {
      next += effectiveMs;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    instance: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    // Restore to active so scheduler can retry
    updateTask(task.id, { status: 'active' });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      consecutive_silent_runs: t.consecutive_silent_runs,
      auto_backoff: !!t.auto_backoff,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  // Clear any leftover send_message flag from a previous turn
  const sendMessageFlagPath = path.join(
    resolveGroupIpcPath(task.group_folder),
    'flags',
    'send_message_called',
  );
  try {
    fs.unlinkSync(sendMessageFlagPath);
  } catch {
    // Flag doesn't exist — expected
  }

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (instance, containerName) =>
        deps.onProcess(
          task.chat_jid,
          instance,
          containerName,
          task.group_folder,
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // If the agent already sent messages via send_message, suppress the
          // final output to avoid duplicate messages (see #165).
          if (fs.existsSync(sendMessageFlagPath)) {
            logger.info(
              { taskId: task.id },
              'Suppressing task output — send_message was already called',
            );
          } else {
            // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
            const raw =
              typeof streamedOutput.result === 'string'
                ? streamedOutput.result
                : JSON.stringify(streamedOutput.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              await deps.sendMessage(task.chat_jid, text);
            }
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  // Determine if this was a "silent run" for auto-backoff purposes:
  // No send_message called AND no visible (non-internal) output
  const sendMessageCalled = fs.existsSync(sendMessageFlagPath);
  let visibleOutput = false;
  if (result) {
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    const stripped = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    visibleOutput = stripped.length > 0;
  }
  const isSilentRun = !error && !sendMessageCalled && !visibleOutput;

  // Update consecutive_silent_runs counter for auto-backoff
  let newSilentRuns: number | undefined;
  if (task.auto_backoff && task.schedule_type !== 'once') {
    if (isSilentRun) {
      newSilentRuns = (task.consecutive_silent_runs || 0) + 1;
      logger.info(
        { taskId: task.id, consecutiveSilentRuns: newSilentRuns },
        'Silent run detected, incrementing backoff counter',
      );
    } else {
      newSilentRuns = 0;
    }
  }

  // Update the task's silent run count before computing next run,
  // so backoff is applied based on the new count
  const taskForNextRun =
    newSilentRuns !== undefined
      ? { ...task, consecutive_silent_runs: newSilentRuns }
      : task;
  const nextRun = computeNextRun(taskForNextRun);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary, newSilentRuns);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled/already running
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        // Mark as 'running' so subsequent polls don't pick it up again.
        // runTask will restore to 'active' (with updated next_run) on
        // completion, or back to 'active' (same next_run) on failure so
        // it gets retried.
        updateTask(currentTask.id, { status: 'running' });

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
