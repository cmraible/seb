import crypto from 'crypto';
import express from 'express';
import http from 'http';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

/** Linear webhook event types we handle */
const SUPPORTED_TYPES = new Set(['Issue', 'Comment']);

/**
 * Verify the Linear webhook signature using HMAC-SHA256.
 * Linear sends the signature in the `Linear-Signature` header.
 */
export function verifyLinearSignature(
  secret: string,
  payload: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Build a group folder name from a Linear issue identifier.
 * Format: linear_{identifier-lowercased} (e.g., linear_eng-123)
 */
export function makeLinearFolder(identifier: string): string {
  const prefix = 'linear_';
  const sanitized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 64 - prefix.length);
  return `${prefix}${sanitized}`;
}

interface FormattedEvent {
  text: string;
  metadata?: Record<string, string>;
}

/** Format a Linear webhook event into a human-readable message */
function formatEvent(
  type: string,
  action: string,
  data: any,
  actor: any,
): FormattedEvent | null {
  const actorName = actor?.name || actor?.id || 'someone';

  switch (type) {
    case 'Issue': {
      const identifier = data.identifier || data.id;
      const title = data.title || '';

      if (action === 'create') {
        const priority = data.priority != null ? ` (P${data.priority})` : '';
        return {
          text: `[Linear] Issue created: ${identifier} "${title}"${priority} by ${actorName}\n${data.url || ''}`,
        };
      }

      if (action === 'update') {
        const changes: string[] = [];

        if (data.assignee) {
          changes.push(`assigned to ${data.assignee.name || data.assignee.id}`);
        }
        if (data.state) {
          changes.push(`status → ${data.state.name || data.state.type}`);
        }
        if (data.priority != null && changes.length === 0) {
          changes.push(`priority → P${data.priority}`);
        }

        if (changes.length === 0) {
          // Generic update — still worth reporting
          changes.push('updated');
        }

        return {
          text: `[Linear] Issue ${identifier} "${title}": ${changes.join(', ')} by ${actorName}\n${data.url || ''}`,
        };
      }

      if (action === 'remove') {
        return {
          text: `[Linear] Issue ${identifier} "${title}" removed by ${actorName}`,
        };
      }

      return null;
    }

    case 'Comment': {
      const issueData = data.issue;
      if (!issueData) return null;

      const identifier = issueData.identifier || issueData.id;
      const body =
        (data.body || '').length > 200
          ? data.body.slice(0, 200) + '...'
          : data.body || '';

      if (action === 'create') {
        return {
          text: `[Linear] Comment on ${identifier} by ${actorName}:\n${body}\n${data.url || ''}`,
          metadata: {
            linear_comment_id: data.id,
            linear_issue_id: issueData.id,
            linear_issue_identifier: identifier,
          },
        };
      }

      return null;
    }

    default:
      return null;
  }
}

export class LinearChannel implements Channel {
  name = 'linear';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private webhookSecret: string;
  private port: number;
  private apiKey: string;
  /** Linear user ID of the bot — issues assigned to this user skip the trigger */
  private botUserId: string;
  /** If set, only process events from these Linear team keys */
  private allowedTeams: Set<string> | null;

  constructor(
    webhookSecret: string,
    port: number,
    apiKey: string,
    botUserId: string,
    opts: ChannelOpts,
    allowedTeams: string[] = [],
  ) {
    this.webhookSecret = webhookSecret;
    this.port = port;
    this.apiKey = apiKey;
    this.botUserId = botUserId;
    this.opts = opts;
    this.allowedTeams = allowedTeams.length > 0 ? new Set(allowedTeams) : null;
  }

  async connect(): Promise<void> {
    const app = express();

    // Parse raw body for signature verification — need raw string
    app.use(
      express.json({
        limit: '1mb',
        verify: (req: any, _res, buf) => {
          req.rawBody = buf.toString('utf-8');
        },
      }),
    );

    app.post('/webhook', (req, res) => {
      const signature = req.headers['linear-signature'] as string;
      const deliveryId = req.headers['linear-delivery'] as string;
      const eventType = req.headers['linear-event'] as string;

      if (!signature) {
        res.status(400).json({ error: 'Missing Linear-Signature header' });
        return;
      }

      // Verify HMAC signature using raw body
      const rawBody = (req as any).rawBody || JSON.stringify(req.body);
      if (!verifyLinearSignature(this.webhookSecret, rawBody, signature)) {
        logger.warn({ deliveryId }, 'Linear webhook signature mismatch');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }

      // Acknowledge immediately
      res.status(200).json({ ok: true });

      const payload = req.body;
      const type = payload.type || eventType;
      const action = payload.action;

      if (!type || !action) {
        logger.debug({ deliveryId }, 'Linear webhook missing type or action');
        return;
      }

      if (!SUPPORTED_TYPES.has(type)) {
        logger.debug({ type }, 'Skipping unsupported Linear event type');
        return;
      }

      // Process asynchronously
      this.processWebhook(type, action, payload, deliveryId).catch((err) =>
        logger.error({ err, type, action }, 'Error processing Linear webhook'),
      );
    });

    // Health check
    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', channel: 'linear' });
    });

    return new Promise<void>((resolve, reject) => {
      this.server = app.listen(this.port, () => {
        logger.info({ port: this.port }, 'Linear webhook server listening');
        console.log(
          `\n  Linear webhooks: http://localhost:${this.port}/webhook`,
        );
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  private async processWebhook(
    type: string,
    action: string,
    payload: any,
    deliveryId: string,
  ): Promise<void> {
    const data = payload.data;
    const actor = payload.actor;
    const timestamp = payload.createdAt || new Date().toISOString();

    if (!data) {
      logger.warn({ type, action }, 'Linear webhook missing data field');
      return;
    }

    // Skip events triggered by the bot itself to avoid feedback loops
    if (this.botUserId && actor?.id === this.botUserId) {
      logger.debug(
        { type, action, actorId: actor.id },
        'Skipping Linear event from bot itself',
      );
      return;
    }

    // Determine the issue identifier and JID
    const issueData = type === 'Comment' ? data.issue : data;
    const identifier = issueData?.identifier;
    if (!identifier) {
      logger.warn({ type, action }, 'Linear webhook missing issue identifier');
      return;
    }

    // Filter by allowed teams if configured
    const teamKey = issueData?.team?.key;
    if (this.allowedTeams && teamKey && !this.allowedTeams.has(teamKey)) {
      logger.debug(
        { teamKey, identifier },
        'Linear event from non-allowed team, skipping',
      );
      return;
    }

    const chatJid = `linear:${identifier}`;
    const senderName = actor?.name || actor?.id?.toString() || 'linear';

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, identifier, 'linear', false);

    // Auto-register group
    if (this.opts.registerGroup) {
      const registered = this.opts.registeredGroups();
      const assigneeId = issueData?.assignee?.id;
      const isAssignedToBot = !!this.botUserId && assigneeId === this.botUserId;

      if (!registered[chatJid]) {
        const folder = makeLinearFolder(identifier);
        const metadata: Record<string, string> = {
          type: 'issue',
          title: issueData?.title || '',
          identifier,
        };
        if (teamKey) metadata.team = teamKey;
        if (issueData?.assignee?.name)
          metadata.assignee = issueData.assignee.name;
        if (issueData?.state?.name) metadata.status = issueData.state.name;
        if (issueData?.priority != null)
          metadata.priority = String(issueData.priority);
        if (issueData?.url) metadata.url = issueData.url;
        if (issueData?.description)
          metadata.description = issueData.description;

        this.opts.registerGroup(chatJid, {
          name: identifier,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: timestamp,
          requiresTrigger: !isAssignedToBot,
          metadata,
        });
        logger.info(
          { chatJid, folder, isAssignedToBot },
          'Auto-registered Linear group',
        );
      } else if (
        type === 'Issue' &&
        action === 'update' &&
        registered[chatJid].requiresTrigger !== !isAssignedToBot
      ) {
        // Assignment changed — update requiresTrigger
        this.opts.registerGroup(chatJid, {
          ...registered[chatJid],
          requiresTrigger: !isAssignedToBot,
          metadata: {
            ...registered[chatJid].metadata,
            ...(issueData?.assignee?.name
              ? { assignee: issueData.assignee.name }
              : {}),
            ...(issueData?.state?.name ? { status: issueData.state.name } : {}),
          },
        });
        logger.info(
          { chatJid, isAssignedToBot },
          'Updated Linear group trigger setting',
        );
      }
    }

    // Format the event
    const formatted = formatEvent(type, action, data, actor);
    if (!formatted) return;

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: deliveryId || crypto.randomUUID(),
      chat_jid: chatJid,
      sender: senderName,
      sender_name: senderName,
      content: formatted.text,
      timestamp,
      is_from_me: false,
      metadata: formatted.metadata,
    });

    logger.info(
      { type, action, chatJid, deliveryId },
      'Linear webhook event processed',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Parse JID: linear:ENG-123
    const match = jid.match(/^linear:(.+)$/);
    if (!match) {
      logger.error({ jid }, 'Invalid Linear JID format');
      return;
    }

    if (!this.apiKey) {
      logger.warn(
        { jid },
        'LINEAR_API_KEY not set — cannot post comment to Linear',
      );
      return;
    }

    const identifier = match[1];

    // Use Linear GraphQL API to post a comment
    // First, look up the issue ID by identifier
    try {
      const issueId = await this.resolveIssueId(identifier);
      if (!issueId) {
        logger.warn(
          { identifier },
          'Could not resolve Linear issue ID from identifier',
        );
        return;
      }

      const mutation = `
        mutation CommentCreate($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment { id }
          }
        }
      `;

      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            input: {
              issueId,
              body: text,
            },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        logger.error(
          { identifier, status: res.status, body },
          'Linear API error posting comment',
        );
        return;
      }

      const result = (await res.json()) as any;
      if (result.errors) {
        logger.error(
          { identifier, errors: result.errors },
          'Linear GraphQL errors posting comment',
        );
        return;
      }

      logger.info(
        { jid, identifier, length: text.length },
        'Linear comment posted',
      );
    } catch (err) {
      logger.error({ jid, identifier, err }, 'Failed to post Linear comment');
    }
  }

  /**
   * Resolve a Linear issue identifier (e.g., ENG-123) to its UUID.
   */
  private async resolveIssueId(identifier: string): Promise<string | null> {
    const query = `
      query IssueByIdentifier($id: String!) {
        issue(id: $id) {
          id
        }
      }
    `;

    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: { id: identifier },
        }),
      });

      if (!res.ok) return null;
      const result = (await res.json()) as any;
      return result.data?.issue?.id ?? null;
    } catch {
      return null;
    }
  }

  isConnected(): boolean {
    return this.server !== null && this.server.listening;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('linear:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
      logger.info('Linear webhook server stopped');
    }
  }
}

registerChannel('linear', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'LINEAR_WEBHOOK_SECRET',
    'LINEAR_WEBHOOK_PORT',
    'LINEAR_API_KEY',
    'LINEAR_BOT_USER_ID',
    'LINEAR_ALLOWED_TEAMS',
  ]);
  const secret =
    process.env.LINEAR_WEBHOOK_SECRET || envVars.LINEAR_WEBHOOK_SECRET || '';
  const port = parseInt(
    process.env.LINEAR_WEBHOOK_PORT || envVars.LINEAR_WEBHOOK_PORT || '0',
    10,
  );
  const apiKey = process.env.LINEAR_API_KEY || envVars.LINEAR_API_KEY || '';
  const botUserId =
    process.env.LINEAR_BOT_USER_ID || envVars.LINEAR_BOT_USER_ID || '';
  const allowedTeamsRaw =
    process.env.LINEAR_ALLOWED_TEAMS || envVars.LINEAR_ALLOWED_TEAMS || '';
  const allowedTeams = allowedTeamsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!secret || !port) {
    logger.warn('Linear: LINEAR_WEBHOOK_SECRET or LINEAR_WEBHOOK_PORT not set');
    return null;
  }

  if (!apiKey) {
    logger.warn(
      'Linear: LINEAR_API_KEY not set — webhook events will be received but replies will not be posted',
    );
  }

  if (botUserId) {
    logger.info(
      { botUserId },
      'Linear: bot user ID configured — assigned issues will skip trigger',
    );
  }

  if (allowedTeams.length > 0) {
    logger.info({ allowedTeams }, 'Linear: team allowlist active');
  }

  return new LinearChannel(secret, port, apiKey, botUserId, opts, allowedTeams);
});
