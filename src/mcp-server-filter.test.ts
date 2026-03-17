import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  getRegisteredGroup,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

/**
 * Tests for per-group MCP server allowlist feature.
 *
 * The filtering itself happens in the agent-runner (container/agent-runner/src/index.ts).
 * These tests verify:
 * 1. The allowedMcpServers field flows through register_group IPC
 * 2. The filtering logic contract (mirrored from agent-runner)
 */

// --- IPC register_group passthrough ---

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
  };

  setRegisteredGroup('main@g.us', MAIN_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
  };
});

describe('register_group with allowedMcpServers', () => {
  it('stores allowedMcpServers when provided', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'work@g.us',
        name: 'Work Chat',
        folder: 'telegram_work',
        trigger: '@Seb',
        allowedMcpServers: ['nanoclaw', '1password'],
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('work@g.us');
    expect(group).toBeDefined();
    expect(group!.allowedMcpServers).toEqual(['nanoclaw', '1password']);
  });

  it('omits allowedMcpServers when not provided (all servers available)', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'personal@g.us',
        name: 'Personal Chat',
        folder: 'telegram_personal',
        trigger: '@Seb',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const group = getRegisteredGroup('personal@g.us');
    expect(group).toBeDefined();
    expect(group!.allowedMcpServers).toBeUndefined();
  });
});

// --- MCP server filtering logic (mirrors agent-runner contract) ---

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Mirror of buildMcpServers from container/agent-runner/src/index.ts.
 * Tests the filtering contract to catch regressions.
 */
function buildMcpServers(
  allServers: Record<string, McpServerConfig>,
  allowedMcpServers?: string[],
): Record<string, McpServerConfig> {
  if (!allowedMcpServers || allowedMcpServers.length === 0) return allServers;

  const filtered: Record<string, McpServerConfig> = {};
  for (const name of allowedMcpServers) {
    if (allServers[name]) filtered[name] = allServers[name];
  }
  return filtered;
}

const ALL_SERVERS: Record<string, McpServerConfig> = {
  nanoclaw: { command: 'node', args: ['mcp.js'] },
  '1password': { command: 'npx', args: ['-y', '@takescake/1password-mcp'] },
  gmail: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
  github: { command: 'npx', args: ['-y', 'github-mcp'] },
};

describe('MCP server filtering', () => {
  it('group with allowedMcpServers only receives those servers', () => {
    const result = buildMcpServers(ALL_SERVERS, ['github']);
    expect(Object.keys(result)).toEqual(['github']);
    expect(result.github).toBeDefined();
    expect(result.nanoclaw).toBeUndefined();
    expect(result['1password']).toBeUndefined();
    expect(result.gmail).toBeUndefined();
  });

  it('group without allowedMcpServers receives all servers', () => {
    const result = buildMcpServers(ALL_SERVERS, undefined);
    expect(Object.keys(result)).toEqual(['nanoclaw', '1password', 'gmail', 'github']);
  });

  it('group with empty allowedMcpServers receives all servers', () => {
    const result = buildMcpServers(ALL_SERVERS, []);
    expect(Object.keys(result)).toEqual(['nanoclaw', '1password', 'gmail', 'github']);
  });

  it('filters to multiple allowed servers', () => {
    const result = buildMcpServers(ALL_SERVERS, ['nanoclaw', 'github']);
    expect(Object.keys(result).sort()).toEqual(['github', 'nanoclaw']);
  });

  it('ignores server names not in the full list', () => {
    const result = buildMcpServers(ALL_SERVERS, ['nonexistent']);
    expect(Object.keys(result)).toEqual([]);
  });
});
