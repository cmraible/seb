import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export interface GitHubGroupContext {
  repo: string;
  type: 'pull_request' | 'issue' | 'repo';
  number?: number;
  title?: string;
  author?: string;
}

/**
 * Parse a GitHub JID into structured context.
 * JID formats: `gh:owner/repo#123` or `gh:owner/repo`
 */
export function parseGitHubJid(
  jid: string,
): { repo: string; number?: number } | null {
  const match = jid.match(/^gh:(.+?)(?:#(\d+))?$/);
  if (!match) return null;
  return {
    repo: match[1],
    number: match[2] ? parseInt(match[2], 10) : undefined,
  };
}

/**
 * Write a CLAUDE.md into a newly created group folder based on context
 * from the channel that registered the group.
 *
 * Currently supports GitHub PR, issue, and repo-level groups.
 * Does nothing if CLAUDE.md already exists or if no context is provided.
 */
export function writeGroupTemplate(
  folder: string,
  jid?: string,
  metadata?: Record<string, string>,
): void {
  const groupDir = resolveGroupFolderPath(folder);
  const targetPath = path.join(groupDir, 'CLAUDE.md');

  // Don't overwrite existing CLAUDE.md
  if (fs.existsSync(targetPath)) return;

  if (!jid) return;

  // Try Linear first
  const linearCtx = parseLinearJid(jid);
  if (linearCtx) {
    const content = generateLinearClaudeMd({
      identifier: linearCtx.identifier,
      title: metadata?.title || '',
      description: metadata?.description,
      status: metadata?.status,
      priority: metadata?.priority,
      team: metadata?.team,
      assignee: metadata?.assignee,
      url: metadata?.url,
    });
    if (content) {
      fs.writeFileSync(targetPath, content, 'utf-8');
    }
    return;
  }

  const parsed = parseGitHubJid(jid);
  if (!parsed) return;

  const type =
    (metadata?.type as GitHubGroupContext['type']) ||
    (parsed.number ? 'pull_request' : 'repo');
  const title = metadata?.title || '';

  const author = metadata?.author;
  const content = generateGitHubClaudeMd({
    repo: parsed.repo,
    type,
    number: parsed.number,
    title,
    author,
  });

  if (content) {
    fs.writeFileSync(targetPath, content, 'utf-8');
  }
}

function generateGitHubClaudeMd(ctx: GitHubGroupContext): string | null {
  switch (ctx.type) {
    case 'pull_request':
      return generatePrClaudeMd(ctx);
    case 'issue':
      return generateIssueClaudeMd(ctx);
    case 'repo':
      return generateRepoClaudeMd(ctx);
    default:
      return null;
  }
}

function generatePrClaudeMd(ctx: GitHubGroupContext): string {
  const titleLine = ctx.title ? ` — ${ctx.title}` : '';
  const authorLine = ctx.author ? `\n- **Author**: ${ctx.author}` : '';
  const isBotPr = ctx.author === 'seb-writes-code';

  const ownPrSection = isBotPr
    ? `
## This Is Your Own PR
This PR was authored by seb-writes-code (you). When you receive review feedback:
- Address every comment with a code fix or explanation
- Push fixes and respond to the reviewer confirming what you changed
- Do NOT dismiss or argue with review feedback — fix the issue or explain why it's intentional
`
    : '';

  return `# GitHub PR Context

You are Seb, an AI code reviewer for a GitHub Pull Request.

## This Group's Context
- **Repo**: ${ctx.repo}
- **PR**: #${ctx.number}${titleLine}${authorLine}
- **URL**: https://github.com/${ctx.repo}/pull/${ctx.number}

## Your Role
You are activated by GitHub webhook events on this PR. You have access to the \`gh\` CLI (authenticated as seb-writes-code) to interact with the PR.
${ownPrSection}
## Behavior
- When a PR is opened, updated, or a review is requested, **automatically review the code** (see Auto-Review below)
- When CI fails (check_suite/check_run events), investigate the failure and push a fix
- When someone leaves a review comment, respond helpfully and address the feedback
- When @seb-writes-code is mentioned in a comment, respond directly
- If this is Seb's own PR (author: seb-writes-code), respond to ALL review comments without needing a mention
- Always include a link to the PR in your messages

## Auto-Review

When you receive a "PR opened", "PR updated", or "Review requested" event, automatically review the code:

### Step 1: Gather Context
- \`gh pr view ${ctx.number} --repo ${ctx.repo}\` — read the PR description
- \`gh pr diff ${ctx.number} --repo ${ctx.repo}\` — fetch the full diff
- \`gh pr checks ${ctx.number} --repo ${ctx.repo}\` — check CI status

### Step 2: Review Against Rubric
Evaluate the PR against each category:

| Category | What to check |
|----------|--------------|
| **Correctness** | Logic bugs, off-by-one errors, null/undefined handling, race conditions |
| **Security** | Injection risks, secrets in code, auth bypass, input validation |
| **Testing** | New code has tests, edge cases covered, tests actually assert behavior |
| **Code quality** | Clear naming, no dead code, reasonable complexity, DRY where appropriate |
| **Patterns** | Consistent with existing codebase conventions, no unnecessary abstractions |

### Step 3: Submit Review
- **Confidence 8-10/10** (no issues or only minor nits): Approve
  \`gh pr review ${ctx.number} --repo ${ctx.repo} --approve --body "..."\`
- **Confidence 5-7/10** (non-blocking concerns): Comment without blocking
  \`gh pr review ${ctx.number} --repo ${ctx.repo} --comment --body "..."\`
- **Confidence 1-4/10** (bugs, security issues, or missing tests): Request changes
  \`gh pr review ${ctx.number} --repo ${ctx.repo} --request-changes --body "..."\`

For inline comments on specific lines, use the GitHub API:
\`gh api repos/${ctx.repo}/pulls/${ctx.number}/reviews --method POST -f body="..." -f event="..." --jsonc comments="[...]"\`

### Step 4: Format Your Review
Structure your review as:

\`\`\`
## Review: [PR title]

**Confidence: N/10** | **Recommendation: Merge / Merge with nits / Needs changes**

### Summary
[1-2 sentences on what the PR does]

### Findings
[List specific issues or observations, grouped by category]

### Verdict
[Clear merge recommendation for the repo maintainer]
\`\`\`

### Confidence Scoring Guide
- **9-10**: Clean, well-tested, follows patterns — merge immediately
- **7-8**: Minor style nits or suggestions, nothing blocking — approve
- **5-6**: Some concerns worth discussing but not clearly wrong — comment
- **3-4**: Missing tests, questionable logic, or pattern violations — request changes
- **1-2**: Security issue, data loss risk, or fundamentally wrong approach — request changes with urgency

## Useful Commands
- \`gh pr view ${ctx.number} --repo ${ctx.repo}\` — view PR details
- \`gh pr diff ${ctx.number} --repo ${ctx.repo}\` — view the diff
- \`gh pr checks ${ctx.number} --repo ${ctx.repo}\` — check CI status
- \`gh pr comment ${ctx.number} --repo ${ctx.repo} --body "..."\` — comment on PR
- \`gh pr review ${ctx.number} --repo ${ctx.repo} --approve --body "..."\` — approve PR
- \`gh pr review ${ctx.number} --repo ${ctx.repo} --request-changes --body "..."\` — request changes

## Installing Dependencies Before Committing
Before making any commits (e.g. CI fixes), install project dependencies so git hooks (husky/lint-staged/prettier) are set up:
\`\`\`bash
if [ -f bun.lockb ] || [ -f bun.lock ]; then bun install
elif [ -f package-lock.json ]; then npm install
elif [ -f yarn.lock ]; then yarn install
elif [ -f pnpm-lock.yaml ]; then pnpm install
fi
\`\`\`

## Repo Location
The repo may be cloned locally. Check \`/workspace/extra/\` for clones.
`;
}

function generateIssueClaudeMd(ctx: GitHubGroupContext): string {
  const titleLine = ctx.title ? ` — ${ctx.title}` : '';
  return `# GitHub Issue Context

You are Seb, an AI assistant helping triage and resolve a GitHub Issue.

## This Group's Context
- **Repo**: ${ctx.repo}
- **Issue**: #${ctx.number}${titleLine}
- **URL**: https://github.com/${ctx.repo}/issues/${ctx.number}

## Your Role
You are activated by GitHub webhook events on this issue. You have access to the \`gh\` CLI (authenticated as seb-writes-code) to interact with the issue.

## Behavior
- When @seb-writes-code or @seb-assistant is mentioned, respond to the comment
- If assigned to this issue, proactively investigate and propose a fix via a new PR
- Before making any commits, install project dependencies so git hooks run: detect lockfile (\`package-lock.json\` → npm, \`bun.lockb\`/\`bun.lock\` → bun, \`yarn.lock\` → yarn, \`pnpm-lock.yaml\` → pnpm) and run the appropriate install command
- Always include a link to the issue in your messages

## Useful Commands
- \`gh issue view ${ctx.number} --repo ${ctx.repo}\` — view issue details
- \`gh issue comment ${ctx.number} --repo ${ctx.repo} --body "..."\` — comment on issue
`;
}

function generateRepoClaudeMd(ctx: GitHubGroupContext): string {
  return `# GitHub Repository Context

You are Seb, monitoring the main branch of a GitHub repository.

## This Group's Context
- **Repo**: ${ctx.repo}
- **Branch**: main
- **URL**: https://github.com/${ctx.repo}

## Your Role
You are activated by check_suite events on the main branch. If CI fails on main, investigate and raise a PR to fix it.

## Installing Dependencies Before Committing
Before making any commits, install project dependencies so git hooks (husky/lint-staged/prettier) run:
\`\`\`bash
if [ -f bun.lockb ] || [ -f bun.lock ]; then bun install
elif [ -f package-lock.json ]; then npm install
elif [ -f yarn.lock ]; then yarn install
elif [ -f pnpm-lock.yaml ]; then pnpm install
fi
\`\`\`

## Useful Commands
- \`gh run list --repo ${ctx.repo} --limit 5\` — check recent CI runs
- \`gh pr create --repo ${ctx.repo} --title "..." --body "..."\` — raise a fix PR
`;
}

// --- Linear support ---

export interface LinearGroupContext {
  identifier: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  team?: string;
  assignee?: string;
  url?: string;
}

/**
 * Parse a Linear JID into structured context.
 * JID format: `linear:ENG-123`
 */
export function parseLinearJid(jid: string): { identifier: string } | null {
  const match = jid.match(/^linear:(.+)$/);
  if (!match) return null;
  return { identifier: match[1] };
}

function generateLinearClaudeMd(ctx: LinearGroupContext): string {
  const titleLine = ctx.title ? ` — ${ctx.title}` : '';
  const priorityLabel =
    ctx.priority != null
      ? {
          '0': 'No priority',
          '1': 'Urgent',
          '2': 'High',
          '3': 'Medium',
          '4': 'Low',
        }[ctx.priority] || `P${ctx.priority}`
      : undefined;

  const metaLines: string[] = [];
  if (ctx.status) metaLines.push(`- **Status**: ${ctx.status}`);
  if (priorityLabel) metaLines.push(`- **Priority**: ${priorityLabel}`);
  if (ctx.team) metaLines.push(`- **Team**: ${ctx.team}`);
  if (ctx.assignee) metaLines.push(`- **Assignee**: ${ctx.assignee}`);
  if (ctx.url) metaLines.push(`- **URL**: ${ctx.url}`);

  const descriptionSection = ctx.description
    ? `\n## Description\n${ctx.description}\n`
    : '';

  return `# Linear Issue: ${ctx.identifier}${titleLine}

You are Seb, an AI agent working on a Linear issue. Your job is to actually implement the requested changes, not just acknowledge them.

## This Issue
- **Issue**: ${ctx.identifier}${titleLine}
${metaLines.join('\n')}
${descriptionSection}
## Agent Activity Protocol

You communicate progress through your output messages. Use these prefixes to emit different activity types in Linear's agent session UI:

- \`[thought] your thinking here\` — Internal reasoning, visible to user as a thought bubble
- \`[action:ActionName] result\` — Tool/action with optional result (e.g., \`[action:Cloning repo] cmraible/seb\`)
- \`[error] what went wrong\` — Report an error
- \`[elicitation] question for user\` — Ask the user a question
- No prefix → Final response (marks session as complete)

**Important**: Send \`[thought]\` and \`[action]\` messages as you work to keep the user informed. Only send an unprefixed message as your final response when done.

## Workflow

When you pick up an issue, drive it through the full pipeline autonomously:

### Phase 1: Research
- Read the issue details and any comments carefully
- Move the issue to **In Progress**: \`mcp__linear__save_issue({ id: "${ctx.identifier}", state: "In Progress" })\`
- Send \`[thought]\` activities as you analyze the problem
- Identify the right repository — common repos:
  - \`cmraible/seb\` — The main NanoClaw/Seb project
  - \`cmraible/sandctl\` — The sandctl CLI project
  - \`cmraible/rebased\` — The Rebased project
- If unsure, check the issue description for repo references or related issues
- Clone the repo and explore the relevant code

\`\`\`bash
cd /tmp
gh repo clone <owner>/<repo> work-repo -- --depth=50
cd work-repo
git remote set-url origin https://x-access-token:$(gh auth token)@github.com/seb-writes-code/<repo>.git
git remote add upstream https://github.com/<owner>/<repo>.git
\`\`\`

Send an \`[action:Cloning repository] owner/repo\` activity.

### Phase 2: Plan
- Design the implementation approach
- Send a \`[thought]\` with your plan summary so the user can see your approach
- Consider edge cases, test coverage, and impact on existing code

### Phase 3: Implement
- Create a feature branch: \`git checkout -b <branch-name>\`
- Install dependencies before making any commits:
\`\`\`bash
if [ -f bun.lockb ] || [ -f bun.lock ]; then bun install
elif [ -f package-lock.json ]; then npm install
elif [ -f yarn.lock ]; then yarn install
elif [ -f pnpm-lock.yaml ]; then pnpm install
fi
\`\`\`
- Make the necessary changes
- Write/update tests when appropriate
- Run the test suite to verify your changes
- Send \`[thought]\` and \`[action]\` activities as you work

### Phase 4: Push and create PR

**CRITICAL**: Always specify \`--repo <owner>/<repo>\` and \`--head seb-writes-code:<branch>\` to ensure the PR targets the correct repo.

\`\`\`bash
git add <files>
git commit -m "description of changes"
git push -u origin <branch-name>
gh pr create --repo <owner>/<repo> --head seb-writes-code:<branch-name> --title "..." --body "..." --reviewer cmraible
gh pr merge <number> --repo <owner>/<repo> --auto --squash
\`\`\`

Send an \`[action:Created PR] #123\` activity.

### Phase 5: Wrap up
- Link the PR to the Linear issue
- Do NOT change the issue status after creating the PR — linking a PR automatically sets it to "In Review", and it will move to "Done" when the PR is merged
- Send your final response (no prefix) summarizing what you did

## Available Tools
- \`gh\` CLI — authenticated as seb-writes-code, for cloning repos, creating PRs, etc.
- \`mcp__linear__*\` — Linear MCP tools for reading/writing issues, comments, status updates
- Standard tools — file operations, bash, web search, etc.

## Important Notes
- You have \`LINEAR_ACCESS_TOKEN\` in your environment for API calls
- You have GitHub access via \`gh\` CLI (authenticated as seb-writes-code)
- **CRITICAL: PRs must target \`cmraible/*\` repos (e.g. \`cmraible/seb\`, \`cmraible/sandctl\`). NEVER open PRs against \`qwibitai/nanoclaw\` or any other upstream.** The \`cmraible/seb\` repo is a fork of \`qwibitai/nanoclaw\`, so \`gh pr create\` without \`--repo\` will incorrectly target \`qwibitai/nanoclaw\`. You MUST always pass \`--repo cmraible/<repo>\`.
- Always create a new branch for your work, never push to main
- If the issue requires changes you can't make (infrastructure, secrets, etc.), explain what's needed in your final response
`;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
