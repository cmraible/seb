import crypto from 'crypto';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { TELEGRAM_BOT_TOKEN } from './config.js';
import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
  getAllChats,
  getAllTasks,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Validate Telegram Web App initData.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData: string, botToken: string): boolean {
  if (!initData || !botToken) return false;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return false;

  // Remove hash from params and sort alphabetically
  params.delete('hash');
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

  // HMAC-SHA256 with secret key derived from bot token
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(hash));
}

/**
 * Extract user info from validated initData.
 */
function parseInitDataUser(
  initData: string,
): { id: number; first_name: string; username?: string } | null {
  const params = new URLSearchParams(initData);
  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

export interface WebAppOpts {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  deleteGroup?: (jid: string) => void;
}

/**
 * Start the Telegram Web App server.
 * Returns the HTTP server instance.
 */
export function startWebApp(
  port: number,
  opts: WebAppOpts,
): Promise<http.Server> {
  const app = express();
  app.use(express.json());

  // Auth middleware: validate Telegram initData
  const authMiddleware: express.RequestHandler = (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'] as string;
    if (!initData || !validateInitData(initData, TELEGRAM_BOT_TOKEN)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  // Serve static files for the frontend.
  // __dirname is src/ in dev or dist/ in compiled mode — both are one level below project root.
  const publicDir = path.join(__dirname, '..', 'src', 'webapp-public');
  app.use('/app', express.static(publicDir));

  // API routes (all require auth)
  const api = express.Router();
  api.use(authMiddleware);

  // GET /api/groups — list all registered groups
  api.get('/groups', (_req, res) => {
    const groups = getAllRegisteredGroups();
    const result = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name: g.name,
      folder: g.folder,
      trigger: g.trigger,
      requiresTrigger: g.requiresTrigger ?? true,
      isMain: g.isMain ?? false,
      containerConfig: g.containerConfig,
      added_at: g.added_at,
    }));
    res.json(result);
  });

  // GET /api/groups/:jid — get single group
  api.get('/groups/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const group = getRegisteredGroup(jid);
    if (!group) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    res.json({
      jid: group.jid,
      name: group.name,
      folder: group.folder,
      trigger: group.trigger,
      requiresTrigger: group.requiresTrigger ?? true,
      isMain: group.isMain ?? false,
      containerConfig: group.containerConfig,
      added_at: group.added_at,
    });
  });

  // PUT /api/groups/:jid — update group config
  api.put('/groups/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const existing = getRegisteredGroup(jid);
    if (!existing) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }

    const updates = req.body;
    const updated: RegisteredGroup = {
      name: updates.name ?? existing.name,
      folder: existing.folder, // folder cannot be changed
      trigger: updates.trigger ?? existing.trigger,
      added_at: existing.added_at,
      requiresTrigger: updates.requiresTrigger ?? existing.requiresTrigger,
      isMain: existing.isMain, // isMain cannot be changed via API
      containerConfig: updates.containerConfig ?? existing.containerConfig,
    };

    setRegisteredGroup(jid, updated);
    // Refresh in-memory state
    opts.registerGroup(jid, updated);
    res.json({ ok: true });
  });

  // POST /api/groups — register a new group
  api.post('/groups', (req, res) => {
    const { jid, name, folder, trigger } = req.body;
    if (!jid || !name || !folder || !trigger) {
      res
        .status(400)
        .json({ error: 'Missing required fields: jid, name, folder, trigger' });
      return;
    }
    if (!isValidGroupFolder(folder)) {
      res.status(400).json({ error: 'Invalid folder name' });
      return;
    }
    const existing = getRegisteredGroup(jid);
    if (existing) {
      res.status(409).json({ error: 'Group already registered' });
      return;
    }

    const group: RegisteredGroup = {
      name,
      folder,
      trigger,
      added_at: new Date().toISOString(),
      requiresTrigger: req.body.requiresTrigger ?? true,
    };

    opts.registerGroup(jid, group);
    res.status(201).json({ ok: true });
  });

  // DELETE /api/groups/:jid — unregister a group
  api.delete('/groups/:jid', (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const existing = getRegisteredGroup(jid);
    if (!existing) {
      res.status(404).json({ error: 'Group not found' });
      return;
    }
    if (existing.isMain) {
      res.status(403).json({ error: 'Cannot delete the main group' });
      return;
    }
    if (opts.deleteGroup) {
      opts.deleteGroup(jid);
    }
    res.json({ ok: true });
  });

  // GET /api/available-groups — list discovered but unregistered groups
  api.get('/available-groups', (_req, res) => {
    const chats = getAllChats();
    const registered = getAllRegisteredGroups();
    const registeredJids = new Set(Object.keys(registered));

    const available = chats
      .filter(
        (c) =>
          c.jid !== '__group_sync__' &&
          c.is_group &&
          !registeredJids.has(c.jid),
      )
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        channel: c.channel,
        lastActivity: c.last_message_time,
      }));

    res.json(available);
  });

  // GET /api/tasks — list scheduled tasks
  api.get('/tasks', (_req, res) => {
    const tasks = getAllTasks().filter(
      (t) =>
        t.status === 'active' ||
        t.status === 'running' ||
        t.status === 'paused',
    );
    res.json(
      tasks.map((t) => ({
        id: t.id,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
        group_folder: t.group_folder,
      })),
    );
  });

  app.use('/api', api);

  // Redirect root to app
  app.get('/', (_req, res) => {
    res.redirect('/app');
  });

  return new Promise<http.Server>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info({ port }, 'Telegram Web App server listening');
      console.log(`\n  Web App: http://localhost:${port}/app`);
      resolve(server);
    });
    server.on('error', reject);
  });
}
