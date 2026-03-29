/**
 * GitHub MCP Proxy
 *
 * Bridges the GitHub MCP stdio server to an HTTP endpoint so containers
 * can access GitHub tools without the GITHUB_TOKEN ever entering the container.
 *
 * Pattern: Host runs the GitHub MCP server with the real token, containers
 * connect to it via HTTP (Streamable HTTP MCP transport).
 */
import http from 'http';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Start the GitHub MCP proxy server.
 * Returns the HTTP server, or null if GITHUB_TOKEN is not configured.
 */
export async function startGitHubMcpProxy(
  port: number,
  host: string,
): Promise<http.Server | null> {
  const { GITHUB_TOKEN } = readEnvFile(['GITHUB_TOKEN']);
  if (!GITHUB_TOKEN) {
    logger.info('No GITHUB_TOKEN found, GitHub MCP proxy disabled');
    return null;
  }

  // 1. Connect to the GitHub MCP server via stdio
  // Ensure nvm bin dir is on PATH so npx and its child node processes resolve
  const nodeBinDir = path.dirname(process.execPath);
  const currentPath = process.env.PATH ?? '';
  const patchedPath = currentPath.includes(nodeBinDir)
    ? currentPath
    : `${nodeBinDir}:${currentPath}`;

  const clientTransport = new StdioClientTransport({
    command: path.join(nodeBinDir, 'npx'),
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      ...process.env,
      PATH: patchedPath,
      GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
    },
  });

  const client = new Client({
    name: 'nanoclaw-github-proxy',
    version: '1.0.0',
  });

  await client.connect(clientTransport);
  logger.info('Connected to GitHub MCP server via stdio');

  // 2. Helper: create a fresh per-request proxy server wired to the shared client.
  // Stateless StreamableHTTPServerTransport requires a new transport (and server)
  // per HTTP request — it throws if handleRequest is called twice on the same instance.
  function createPerRequestServer(): Server {
    const server = new Server(
      { name: 'github-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return client.listTools();
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      return client.callTool(request.params);
    });
    return server;
  }

  // 3. Create HTTP server — each request gets its own transport + server
  const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
          return;
        }

        const server = createPerRequestServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        res.on('close', () => {
          transport.close();
          server.close();
        });
      });
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return new Promise((resolve, reject) => {
    httpServer.listen(port, host, () => {
      logger.info({ port, host }, 'GitHub MCP proxy started');
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });
}
