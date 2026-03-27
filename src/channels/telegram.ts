import { Api, Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN, WEBAPP_URL } from '../config.js';
import { readEnvFile } from '../env.js';
import { formatNextRun, formatSchedule } from '../format-schedule.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
  ScheduledTask,
} from '../types.js';

/** Sanitize a string for use as a folder name segment */
function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  getActiveTasks?: () => ScheduledTask[];
  cancelTask?: (taskId: string) => void;
  pauseTask?: (taskId: string) => void;
  resumeTask?: (taskId: string) => void;
  requestRestart?: () => void;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const topicId = (ctx.message as any)?.message_thread_id;
      const chatJid = topicId ? `tg:${chatId}:${topicId}` : `tg:${chatId}`;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`${chatJid}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to restart the bot process
    this.bot.command('restart', async (ctx) => {
      const topicId = (ctx.message as any)?.message_thread_id;
      const chatJid = topicId
        ? `tg:${ctx.chat.id}:${topicId}`
        : `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      if (!group?.isMain) {
        await ctx.reply('⚠️ /restart is only available in the main group.');
        return;
      }

      if (!this.opts.requestRestart) {
        await ctx.reply('Restart is not available.');
        return;
      }

      logger.info(
        { requestedBy: ctx.from?.username || ctx.from?.id },
        'Restart requested via /restart command',
      );
      await ctx.reply('Restarting NanoClaw...');
      // Delay restart so grammy can advance the Telegram update offset.
      // Without this, the /restart update is re-delivered on every startup → bootloop.
      setTimeout(() => this.opts.requestRestart!(), 500);
    });

    // Remote control commands — forward through onMessage so the handler
    // in index.ts can intercept them (main-group only guard is there).
    const forwardCommand = (commandText: string) => async (ctx: any) => {
      const topicId = (ctx.message as any)?.message_thread_id;
      const chatJid = topicId
        ? `tg:${ctx.chat.id}:${topicId}`
        : `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const sender = ctx.from?.id?.toString() || '';
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;
      this.opts.onChatMetadata(chatJid, timestamp, chatName);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: commandText,
        timestamp,
        is_from_me: false,
      });
    };
    this.bot.command('rc', forwardCommand('/rc'));
    this.bot.command('rcend', forwardCommand('/rcend'));
    this.bot.command('rc_end', forwardCommand('/rc-end'));

    // Command to list and manage scheduled tasks
    this.bot.command('tasks', (ctx) => {
      if (!this.opts.getActiveTasks) {
        ctx.reply('Task management is not available.');
        return;
      }

      const tasks = this.opts.getActiveTasks();
      if (tasks.length === 0) {
        ctx.reply('No active scheduled tasks.');
        return;
      }

      // Find group names for cross-group task display
      const groups = this.opts.registeredGroups();
      const jidToName = new Map<string, string>();
      for (const [jid, group] of Object.entries(groups)) {
        jidToName.set(jid, group.name);
      }

      const lines: string[] = ['📋 *Scheduled Tasks*'];
      const keyboard = new InlineKeyboard();

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        const num = i + 1;
        // Extract a meaningful summary: first line of the prompt, trimmed
        const firstLine = t.prompt.split('\n')[0].trim();
        const preview =
          firstLine.length > 100 ? firstLine.slice(0, 97) + '...' : firstLine;
        const schedule = formatSchedule(t.schedule_type, t.schedule_value);
        const nextRun = formatNextRun(t.next_run);
        const groupName = jidToName.get(t.chat_jid);

        // Status indicator
        let statusIcon = '✅';
        if (t.status === 'running') statusIcon = '🔄';
        else if (t.status === 'paused') statusIcon = '⏸';
        else if (t.status === 'completed') statusIcon = '✔️';

        let line = `${statusIcon} *${num}.* ${preview}`;
        line += `\n    ⏰ ${schedule}`;
        if (nextRun) line += ` (next: ${nextRun})`;
        if (groupName) line += `\n    📍 ${groupName}`;
        lines.push(line);

        // Only show action buttons for non-completed tasks
        if (t.status !== 'completed') {
          if (t.status === 'paused') {
            keyboard.text(`▶ ${num}`, `resume_task:${t.id}`);
          } else {
            keyboard.text(`⏸ ${num}`, `pause_task:${t.id}`);
          }
          keyboard.text(`✕ ${num}`, `cancel_task:${t.id}`);
          keyboard.row();
        }
      }

      ctx.reply(lines.join('\n\n'), {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // Handle inline button callbacks for task management
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;

      if (data.startsWith('cancel_task:')) {
        const taskId = data.slice('cancel_task:'.length);
        if (!this.opts.cancelTask || !this.opts.getActiveTasks) {
          await ctx.answerCallbackQuery({
            text: 'Task management unavailable.',
          });
          return;
        }
        const tasks = this.opts.getActiveTasks();
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          await ctx.answerCallbackQuery({
            text: 'Task not found or already cancelled.',
          });
          return;
        }
        this.opts.cancelTask(taskId);
        await ctx.answerCallbackQuery({ text: '✅ Task cancelled.' });
        try {
          await ctx.editMessageText(
            `${ctx.callbackQuery.message?.text}\n\n✅ Cancelled: ${task.prompt.slice(0, 60)}`,
          );
        } catch {
          // Message may have been deleted or is too old to edit
        }
        logger.info({ taskId }, 'Task cancelled via inline button');
      } else if (data.startsWith('pause_task:')) {
        const taskId = data.slice('pause_task:'.length);
        if (!this.opts.pauseTask || !this.opts.getActiveTasks) {
          await ctx.answerCallbackQuery({
            text: 'Task management unavailable.',
          });
          return;
        }
        const tasks = this.opts.getActiveTasks();
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          await ctx.answerCallbackQuery({ text: 'Task not found.' });
          return;
        }
        this.opts.pauseTask(taskId);
        await ctx.answerCallbackQuery({ text: '⏸ Task paused.' });
        logger.info({ taskId }, 'Task paused via inline button');
      } else if (data.startsWith('resume_task:')) {
        const taskId = data.slice('resume_task:'.length);
        if (!this.opts.resumeTask || !this.opts.getActiveTasks) {
          await ctx.answerCallbackQuery({
            text: 'Task management unavailable.',
          });
          return;
        }
        const tasks = this.opts.getActiveTasks();
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          await ctx.answerCallbackQuery({ text: 'Task not found.' });
          return;
        }
        this.opts.resumeTask(taskId);
        await ctx.answerCallbackQuery({ text: '▶ Task resumed.' });
        logger.info({ taskId }, 'Task resumed via inline button');
      }
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const topicId = ctx.message.message_thread_id;
      const chatJid = topicId
        ? `tg:${ctx.chat.id}:${topicId}`
        : `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Auto-register topic groups on first trigger message
      const groups = this.opts.registeredGroups();
      if (
        topicId &&
        !groups[chatJid] &&
        TRIGGER_PATTERN.test(content) &&
        this.opts.registerGroup
      ) {
        const topicName =
          (ctx.message.reply_to_message as any)?.forum_topic_created?.name ||
          `topic-${topicId}`;
        const folderName = `tg-${sanitize(chatName)}-${sanitize(topicName)}`;
        this.opts.registerGroup(chatJid, {
          name: `${chatName} / ${topicName}`,
          folder: folderName,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      // Include telegram metadata so the agent-side ack can react with 👀
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        metadata: {
          telegram_chat_id: String(ctx.chat.id),
          telegram_message_id: msgId,
        },
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const topicId = ctx.message?.message_thread_id;
      const chatJid = topicId
        ? `tg:${ctx.chat.id}:${topicId}`
        : `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Set menu button to open the Web App if WEBAPP_URL is configured
    if (WEBAPP_URL) {
      try {
        await this.bot.api.setChatMenuButton({
          menu_button: {
            type: 'web_app',
            text: 'Manage',
            web_app: { url: `${WEBAPP_URL}/app` },
          },
        });
        logger.info({ url: WEBAPP_URL }, 'Telegram menu button set to Web App');
      } catch (err) {
        logger.warn({ err }, 'Failed to set Telegram menu button');
      }
    }

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const match = jid.match(/^tg:(-?\d+)(?::(\d+))?$/);
      if (!match) {
        logger.error({ jid }, 'Invalid Telegram JID format');
        return;
      }
      const [, chatId, topicId] = match;
      const threadOpts = topicId
        ? { message_thread_id: parseInt(topicId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, text, threadOpts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            chatId,
            text.slice(i, i + MAX_LENGTH),
            threadOpts,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const match = jid.match(/^tg:(-?\d+)(?::(\d+))?$/);
      if (!match) return;
      const [, chatId, topicId] = match;
      await this.bot.api.sendChatAction(
        chatId,
        'typing',
        topicId ? { message_thread_id: parseInt(topicId, 10) } : undefined,
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async ack(jid: string, context?: Record<string, string>): Promise<void> {
    if (!this.bot || !context) return;
    const chatId = context.telegram_chat_id;
    const messageId = context.telegram_message_id;
    if (!chatId || !messageId) return;
    try {
      await this.bot.api.setMessageReaction(chatId, parseInt(messageId, 10), [
        { type: 'emoji', emoji: '👀' },
      ]);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to add Telegram eyes reaction');
    }
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; stable per group+sender.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) return;

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, {
    ...opts,
    registerGroup: opts.registerGroup,
    getActiveTasks: opts.getActiveTasks,
    cancelTask: opts.cancelTask,
    pauseTask: opts.pauseTask,
    resumeTask: opts.resumeTask,
    requestRestart: opts.requestRestart,
  });
});
