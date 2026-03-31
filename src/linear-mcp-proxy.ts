/**
 * Linear MCP Proxy
 *
 * Bridges the Linear MCP API to a local HTTP endpoint so containers
 * can access Linear tools without the LINEAR_ACCESS_TOKEN ever entering the container.
 *
 * Pattern: Host holds the real Linear OAuth token and proxies requests to
 * Linear's hosted MCP server (https://mcp.linear.app/mcp). Containers
 * connect to this proxy via HTTP (Streamable HTTP MCP transport).
 */
import http from 'http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { logger } from './logger.js';

/**
 * Start the Linear MCP proxy server.
 * Returns the HTTP server, or null if LINEAR_ACCESS_TOKEN is not configured.
 */
export async function startLinearMcpProxy(
  port: number,
  host: string,
  accessToken: string,
): Promise<http.Server | null> {
  if (!accessToken) {
    logger.info('No LINEAR_ACCESS_TOKEN found, Linear MCP proxy disabled');
    return null;
  }

  // 1. Connect to Linear's hosted MCP server via HTTP
  const clientTransport = new StreamableHTTPClientTransport(
    new URL('https://mcp.linear.app/mcp'),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    },
  );

  const client = new Client({
    name: 'nanoclaw-linear-proxy',
    version: '1.0.0',
  });

  await client.connect(clientTransport);
  logger.info('Connected to Linear MCP server via HTTP');

  // 2. Helper: create a fresh per-request proxy server wired to the shared client.
  // Stateless StreamableHTTPServerTransport requires a new transport (and server)
  // per HTTP request — it throws if handleRequest is called twice on the same instance.
  function createPerRequestServer(): Server {
    const server = new Server(
      { name: 'linear-proxy', version: '1.0.0' },
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
      logger.info({ port, host }, 'Linear MCP proxy started');
      resolve(httpServer);
    });
    httpServer.on('error', reject);
  });
}
