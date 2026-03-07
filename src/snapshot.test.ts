import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing anything that depends on it
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
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

// Track fs calls
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import fs from 'fs';
import {
  writeTasksSnapshot,
  writeGroupsSnapshot,
  AvailableGroup,
} from './container-runner.js';

const mkdirSync = vi.mocked(fs.mkdirSync);
const writeFileSync = vi.mocked(fs.writeFileSync);

beforeEach(() => {
  mkdirSync.mockClear();
  writeFileSync.mockClear();
});

// --- writeTasksSnapshot ---

describe('writeTasksSnapshot', () => {
  const allTasks = [
    {
      id: 'task-1',
      groupFolder: 'group-a',
      prompt: 'do thing',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      status: 'active',
      next_run: '2026-03-08T09:00:00.000Z',
    },
    {
      id: 'task-2',
      groupFolder: 'group-b',
      prompt: 'other thing',
      schedule_type: 'interval',
      schedule_value: '60000',
      status: 'active',
      next_run: '2026-03-08T10:00:00.000Z',
    },
    {
      id: 'task-3',
      groupFolder: 'group-a',
      prompt: 'another thing',
      schedule_type: 'once',
      schedule_value: '2026-03-08T12:00:00.000Z',
      status: 'paused',
      next_run: null,
    },
  ];

  it('main group sees all tasks regardless of groupFolder', () => {
    writeTasksSnapshot('group-a', true, allTasks);

    expect(writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(3);
    expect(written.map((t: any) => t.id)).toEqual([
      'task-1',
      'task-2',
      'task-3',
    ]);
  });

  it('non-main group sees only its own tasks', () => {
    writeTasksSnapshot('group-a', false, allTasks);

    expect(writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(2);
    expect(written.map((t: any) => t.id)).toEqual(['task-1', 'task-3']);
  });

  it('non-main group with no matching tasks gets empty array', () => {
    writeTasksSnapshot('group-c', false, allTasks);

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written).toHaveLength(0);
  });

  it('creates IPC directory before writing', () => {
    writeTasksSnapshot('group-a', false, allTasks);

    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('group-a'), {
      recursive: true,
    });
    // mkdirSync must be called before writeFileSync
    const mkdirOrder = mkdirSync.mock.invocationCallOrder[0];
    const writeOrder = writeFileSync.mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });

  it('writes to current_tasks.json in the IPC directory', () => {
    writeTasksSnapshot('group-a', true, allTasks);

    const filePath = writeFileSync.mock.calls[0][0] as string;
    expect(filePath).toMatch(/group-a\/current_tasks\.json$/);
  });
});

// --- writeGroupsSnapshot ---

describe('writeGroupsSnapshot', () => {
  const allGroups: AvailableGroup[] = [
    {
      jid: 'group1@g.us',
      name: 'Group 1',
      lastActivity: '2026-03-07T10:00:00.000Z',
      isRegistered: true,
    },
    {
      jid: 'tg:-1001234567890',
      name: 'TG Group',
      lastActivity: '2026-03-07T09:00:00.000Z',
      isRegistered: false,
    },
  ];

  it('main group sees all available groups', () => {
    writeGroupsSnapshot('main-group', true, allGroups);

    expect(writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.groups).toHaveLength(2);
    expect(written.groups[0].jid).toBe('group1@g.us');
    expect(written.groups[1].jid).toBe('tg:-1001234567890');
  });

  it('non-main group sees empty groups array', () => {
    writeGroupsSnapshot('other-group', false, allGroups);

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.groups).toHaveLength(0);
  });

  it('includes lastSync timestamp', () => {
    writeGroupsSnapshot('main-group', true, allGroups);

    const written = JSON.parse(writeFileSync.mock.calls[0][1] as string);
    expect(written.lastSync).toBeDefined();
    // Should be a valid ISO timestamp
    expect(new Date(written.lastSync).toISOString()).toBe(written.lastSync);
  });

  it('writes to available_groups.json in the IPC directory', () => {
    writeGroupsSnapshot('main-group', true, allGroups);

    const filePath = writeFileSync.mock.calls[0][0] as string;
    expect(filePath).toMatch(/main-group\/available_groups\.json$/);
  });

  it('creates IPC directory before writing', () => {
    writeGroupsSnapshot('main-group', true, allGroups);

    expect(mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('main-group'),
      { recursive: true },
    );
  });
});
