import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { type GitHubAppConfig } from './config.js';
import { TokenMinter } from './token-minter.js';

const GITHUB_API = 'https://api.github.com';

export const BROKER_TOKEN_FILE = path.join(DATA_DIR, 'github-app-broker.token');

interface BrokerHandle {
  server: http.Server;
  token: string;
  url: string;
}

let active: BrokerHandle | null = null;

export function getActiveBroker(): { url: string; token: string } | null {
  if (!active) return null;
  return { url: active.url, token: active.token };
}

interface ToolRequest {
  installationId?: number;
  owner?: string;
  repo?: string;
  number?: number;
  path?: string;
  ref?: string;
  state?: string;
  body?: string;
}

type ToolHandler = (
  minter: TokenMinter,
  defaultInstallationId: number | undefined,
  req: ToolRequest,
) => Promise<unknown>;

async function callGithub(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${url} failed (${res.status}): ${text}`);
  return text ? JSON.parse(text) : null;
}

async function resolveInstallationToken(
  minter: TokenMinter,
  defaultInstallationId: number | undefined,
  req: ToolRequest,
): Promise<string> {
  if (req.installationId) return minter.getInstallationToken(req.installationId);
  if (req.owner && req.repo) {
    const id = await minter.getInstallationForRepo(req.owner, req.repo);
    return minter.getInstallationToken(id);
  }
  if (defaultInstallationId) return minter.getInstallationToken(defaultInstallationId);
  throw new Error(
    'No installation available — pass installationId, owner+repo, or set GITHUB_APP_DEFAULT_INSTALLATION_ID',
  );
}

const TOOLS: Record<string, ToolHandler> = {
  whoami_app: async (minter) => {
    const jwt = minter.signAppJwt();
    return callGithub(`${GITHUB_API}/app`, minter.appAuthHeaders(jwt));
  },

  list_installations: async (minter) => {
    const jwt = minter.signAppJwt();
    return callGithub(`${GITHUB_API}/app/installations`, minter.appAuthHeaders(jwt));
  },

  get_repo: async (minter, def, req) => {
    if (!req.owner || !req.repo) throw new Error('owner and repo required');
    const token = await resolveInstallationToken(minter, def, req);
    return callGithub(`${GITHUB_API}/repos/${req.owner}/${req.repo}`, minter.installationHeaders(token));
  },

  get_file_contents: async (minter, def, req) => {
    if (!req.owner || !req.repo || !req.path) throw new Error('owner, repo, path required');
    const token = await resolveInstallationToken(minter, def, req);
    const qs = req.ref ? `?ref=${encodeURIComponent(req.ref)}` : '';
    return callGithub(
      `${GITHUB_API}/repos/${req.owner}/${req.repo}/contents/${req.path}${qs}`,
      minter.installationHeaders(token),
    );
  },

  list_pull_requests: async (minter, def, req) => {
    if (!req.owner || !req.repo) throw new Error('owner and repo required');
    const token = await resolveInstallationToken(minter, def, req);
    const qs = req.state ? `?state=${encodeURIComponent(req.state)}` : '';
    return callGithub(`${GITHUB_API}/repos/${req.owner}/${req.repo}/pulls${qs}`, minter.installationHeaders(token));
  },

  get_pull_request: async (minter, def, req) => {
    if (!req.owner || !req.repo || req.number == null) throw new Error('owner, repo, number required');
    const token = await resolveInstallationToken(minter, def, req);
    return callGithub(
      `${GITHUB_API}/repos/${req.owner}/${req.repo}/pulls/${req.number}`,
      minter.installationHeaders(token),
    );
  },

  add_issue_comment: async (minter, def, req) => {
    if (!req.owner || !req.repo || req.number == null || !req.body) {
      throw new Error('owner, repo, number, body required');
    }
    const token = await resolveInstallationToken(minter, def, req);
    return callGithub(
      `${GITHUB_API}/repos/${req.owner}/${req.repo}/issues/${req.number}/comments`,
      minter.installationHeaders(token),
      { method: 'POST', body: JSON.stringify({ body: req.body }) },
    );
  },
};

export function listToolNames(): string[] {
  return Object.keys(TOOLS);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

function ensureTokenFile(token: string): void {
  fs.mkdirSync(path.dirname(BROKER_TOKEN_FILE), { recursive: true });
  fs.writeFileSync(BROKER_TOKEN_FILE, token, { mode: 0o600 });
}

export async function startGitHubAppBroker(config: GitHubAppConfig): Promise<BrokerHandle> {
  if (active) return active;

  const minter = new TokenMinter(config.appId, config.privateKeyPem);
  const token = crypto.randomBytes(32).toString('hex');
  ensureTokenFile(token);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, minter, token, config.defaultInstallationId);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const url = `http://host.docker.internal:${config.port}`;
  active = { server, token, url };
  log.info('GitHub App broker started', { bind: config.bind, port: config.port, tools: listToolNames() });
  return active;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  minter: TokenMinter,
  brokerToken: string,
  defaultInstallationId: number | undefined,
): Promise<void> {
  const url = req.url || '/';

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tools: listToolNames() }));
    return;
  }

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${brokerToken}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const match = url.match(/^\/v1\/tools\/([a-z_]+)$/);
  if (!match || req.method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const toolName = match[1];
  const handler = TOOLS[toolName];
  if (!handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `unknown tool: ${toolName}` }));
    return;
  }

  let body: ToolRequest;
  try {
    body = (await readJsonBody(req)) as ToolRequest;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
    return;
  }

  try {
    const result = await handler(minter, defaultInstallationId, body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result }));
  } catch (err) {
    log.warn('GitHub App tool failed', { tool: toolName, err: String(err) });
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

export async function stopGitHubAppBroker(): Promise<void> {
  if (!active) return;
  await new Promise<void>((resolve) => active!.server.close(() => resolve()));
  try {
    fs.unlinkSync(BROKER_TOKEN_FILE);
  } catch {
    // file may already be gone
  }
  active = null;
  log.info('GitHub App broker stopped');
}
