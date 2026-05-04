/**
 * Stdio MCP bridge → host-side GitHub App broker.
 *
 * The container has no GitHub App credentials. This bridge exposes a small
 * set of MCP tools that forward to the host broker over loopback HTTP. The
 * broker (src/github-app/) holds the App private key, mints installation
 * tokens, and calls the GitHub API.
 *
 * Wiring: container-runner injects GITHUB_APP_BROKER_URL and
 * GITHUB_APP_BROKER_TOKEN as env vars when the broker is running. To enable
 * for an agent group, add to its container.json mcpServers:
 *
 *   "github_app": {
 *     "command": "bun",
 *     "args": ["run", "/app/src/mcp-bridges/github-app.ts"],
 *     "env": {}
 *   }
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BROKER_URL = process.env.GITHUB_APP_BROKER_URL;
const BROKER_TOKEN = process.env.GITHUB_APP_BROKER_TOKEN;
const INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID
  ? parseInt(process.env.GITHUB_APP_INSTALLATION_ID, 10)
  : undefined;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const REPO_PROPS = {
  owner: { type: 'string', description: 'Repository owner (user or org)' },
  repo: { type: 'string', description: 'Repository name' },
};

const TOOLS: ToolDef[] = [
  {
    name: 'whoami_app',
    description: 'Return metadata about the GitHub App this broker is acting as.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_installations',
    description: 'List all installations of this GitHub App.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_repo',
    description: 'Get repository metadata.',
    inputSchema: { type: 'object', properties: REPO_PROPS, required: ['owner', 'repo'] },
  },
  {
    name: 'get_file_contents',
    description: 'Get the contents of a file or directory in a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        path: { type: 'string', description: 'File path within the repo' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA (optional)' },
      },
      required: ['owner', 'repo', 'path'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repo.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get a specific pull request by number.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_PROPS, number: { type: 'number', description: 'PR number' } },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'add_issue_comment',
    description: 'Post a comment on an issue or pull request as the GitHub App.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPS,
        number: { type: 'number', description: 'Issue or PR number' },
        body: { type: 'string', description: 'Markdown body of the comment' },
      },
      required: ['owner', 'repo', 'number', 'body'],
    },
  },
];

async function callBroker(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!BROKER_URL || !BROKER_TOKEN) {
    throw new Error('GitHub App broker not configured (GITHUB_APP_BROKER_URL/TOKEN missing)');
  }
  // Stamp the agent group's pinned installation id when the caller didn't
  // pass one and the call has no owner/repo to resolve from.
  const reqBody: Record<string, unknown> = { ...args };
  if (INSTALLATION_ID && reqBody.installationId == null && (reqBody.owner == null || reqBody.repo == null)) {
    reqBody.installationId = INSTALLATION_ID;
  }
  const res = await fetch(`${BROKER_URL}/v1/tools/${tool}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BROKER_TOKEN}` },
    body: JSON.stringify(reqBody),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broker error (${res.status}): ${text}`);
  const resBody = JSON.parse(text) as { result?: unknown; error?: string };
  if (resBody.error) throw new Error(resBody.error);
  return resBody.result;
}

const server = new Server({ name: 'github_app', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const result = await callBroker(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: String(err) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
