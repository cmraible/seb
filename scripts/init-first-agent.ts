/**
 * Init the first (or Nth) NanoClaw v2 agent for a DM channel.
 *
 * Wires a real DM channel (discord, telegram, etc.) to a new agent group,
 * then hands a welcome message to the running service via the CLI socket
 * (admin transport). The service routes that message into the DM session,
 * which wakes the container synchronously — the agent processes the welcome
 * and DMs the operator through the normal delivery path.
 *
 * CLI channel wiring is handled separately by `scripts/init-cli-agent.ts`.
 *
 * Creates/reuses: user, owner grant (if none), agent group + filesystem,
 * messaging group(s), wiring.
 *
 * Runs alongside the service (WAL-mode sqlite + CLI socket IPC) — does NOT
 * initialize channel adapters, so there's no Gateway conflict. Requires
 * the service to be running: the welcome hand-off goes over the CLI socket
 * and fails loudly if the service isn't up.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-first-agent.ts \
 *     --channel discord \
 *     --user-id discord:1470183333427675709 \
 *     --platform-id discord:@me:1491573333382523708 \
 *     --display-name "Gavriel" \
 *     [--agent-name "Andy"] \
 *     [--welcome "System instruction: ..."]
 *
 * For direct-addressable channels (telegram, whatsapp, etc.), --platform-id
 * is typically the same as the handle in --user-id, with the channel prefix.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { normalizeName } from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { grantRole, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup, MessagingGroup } from '../src/types.js';

interface Args {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  welcome: string;
}

const DEFAULT_WELCOME =
  'System instruction: run /welcome to introduce yourself to the user on this new channel.';

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--channel':
        out.channel = (val ?? '').toLowerCase();
        i++;
        break;
      case '--user-id':
        out.userId = val;
        i++;
        break;
      case '--platform-id':
        out.platformId = val;
        i++;
        break;
      case '--display-name':
        out.displayName = val;
        i++;
        break;
      case '--agent-name':
        out.agentName = val;
        i++;
        break;
      case '--welcome':
        out.welcome = val;
        i++;
        break;
    }
  }

  const required: (keyof Args)[] = ['channel', 'userId', 'platformId', 'displayName'];
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    console.error(
      `Missing required args: ${missing.map((k) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`).join(', ')}`,
    );
    console.error('See scripts/init-first-agent.ts header for usage.');
    process.exit(2);
  }

  return {
    channel: out.channel!,
    userId: out.userId!,
    platformId: out.platformId!,
    displayName: out.displayName!,
    agentName: out.agentName?.trim() || out.displayName!,
    welcome: out.welcome?.trim() || DEFAULT_WELCOME,
  };
}

function namespacedUserId(channel: string, raw: string): string {
  return raw.includes(':') ? raw : `${channel}:${raw}`;
}

function namespacedPlatformId(channel: string, raw: string): string {
  return raw.startsWith(`${channel}:`) ? raw : `${channel}:${raw}`;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wireIfMissing(mg: MessagingGroup, ag: AgentGroup, now: string, label: string): void {
  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (existing) {
    console.log(`Wiring already exists: ${existing.id} (${label})`);
    return;
  }
  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    // DM / CLI (is_group=0) default to "respond to everything" via a '.' regex.
    // Group chats default to mention-only; admins can upgrade to mention-sticky
    // via /manage-channels once the agent is in use.
    engage_mode: mg.is_group === 0 ? 'pattern' : 'mention',
    engage_pattern: mg.is_group === 0 ? '.' : null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired ${label}: ${mg.id} -> ${ag.id}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent

  const now = new Date().toISOString();

  // 1. User + (conditional) owner grant.
  const userId = namespacedUserId(args.channel, args.userId);
  upsertUser({
    id: userId,
    kind: args.channel,
    display_name: args.displayName,
    created_at: now,
  });

  let promotedToOwner = false;
  if (!hasAnyOwner()) {
    grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    promotedToOwner = true;
  }

  // 2. Agent group + filesystem.
  const folder = `dm-with-${normalizeName(args.displayName)}`;
  let ag: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = generateId('ag');
    createAgentGroup({
      id: agId,
      name: args.agentName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${ag.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${folder})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${args.agentName}\n\n` +
      `You are ${args.agentName}, a personal NanoClaw agent for ${args.displayName}. ` +
      'When the user first reaches out (or you receive a system welcome prompt), introduce yourself briefly and invite them to chat. Keep replies concise.',
  });

  // 3. DM messaging group.
  const platformId = namespacedPlatformId(args.channel, args.platformId);
  let dmMg = getMessagingGroupByPlatform(args.channel, platformId);
  if (!dmMg) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: args.channel,
      platform_id: platformId,
      name: args.displayName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    dmMg = getMessagingGroupByPlatform(args.channel, platformId)!;
    console.log(`Created messaging group: ${dmMg.id} (${platformId})`);
  } else {
    console.log(`Reusing messaging group: ${dmMg.id} (${platformId})`);
  }

  // 4. Wire DM messaging group to the agent.
  wireIfMissing(dmMg, ag, now, 'dm');

  // 5. Welcome delivery over the CLI socket. Router picks up the line,
  // writes the message into the DM session's inbound.db, and wakes the
  // container synchronously — no sweep wait. The paired user's identity is
  // passed so the sender resolver sees the real owner, not cli:local.
  await sendWelcomeViaCliSocket(dmMg, args.welcome, {
    senderId: userId,
    sender: args.displayName,
  });

  console.log('');
  console.log('Init complete.');
  console.log(`  owner:   ${userId}${promotedToOwner ? ' (promoted on first owner)' : ''}`);
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${folder}`);
  console.log(`  channel: ${args.channel} ${dmMg.platform_id}`);
  console.log('');
  console.log('Welcome DM queued — the agent will greet you shortly.');
}

/**
 * Hand the welcome to the running service via its CLI Unix socket. The
 * service's CLI adapter receives `{text, to}`, builds an InboundEvent
 * targeting the DM messaging group, and calls routeInbound(). Router writes
 * the message into inbound.db and wakes the container synchronously.
 *
 * Throws if the socket isn't reachable — this script requires the service
 * to be running.
 */
async function sendWelcomeViaCliSocket(
  dmMg: MessagingGroup,
  welcome: string,
  identity: { senderId: string; sender: string },
): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;

    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };

    socket.once('error', (err) =>
      settle(
        new Error(
          `CLI socket at ${sockPath} not reachable: ${err.message}. Is the NanoClaw service running?`,
        ),
      ),
    );
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text: welcome,
          senderId: identity.senderId,
          sender: identity.sender,
          to: {
            channelType: dmMg.channel_type,
            platformId: dmMg.platform_id,
            threadId: null,
          },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) {
          settle(err);
          return;
        }
        // Brief flush delay so the router picks up the line before we close.
        // Router handles it synchronously once read, so 50ms is plenty.
        setTimeout(() => settle(null), 50);
      });
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
