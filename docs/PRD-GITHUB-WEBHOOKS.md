# PRD: GitHub Webhook Integration

## Problem

NanoClaw is currently limited to pull-based communication channels (WhatsApp polling, Telegram long-polling). There is no way for the agent to be notified by external services when something happens.

Specifically, the agent has a GitHub identity (`seb-writes-code`) and actively works with GitHub repos — creating PRs, resolving issues, reviewing code. But it cannot be _notified_ when:

- An issue is assigned to it
- A PR review is requested
- Someone comments on one of its PRs
- A CI check fails on a PR it created
- It's mentioned in a discussion or comment

Today, the only workaround is polling the GitHub API on a schedule, which is wasteful and introduces latency.

## Proposal

Add a lightweight HTTP webhook server to NanoClaw that receives GitHub events via a **GitHub App**, converts them into messages, and routes them to the agent through the existing message processing pipeline.

## Why a GitHub App (Not Repo Webhooks)

Repository-level webhooks require manual per-repo configuration. A GitHub App:

- Configures webhook delivery automatically when installed on a repo or org
- Can be installed org-wide with a single click, covering all current and future repos
- Provides fine-grained permissions (read-only issues, read-only PRs, etc.)
- Shows up as a proper `[bot]` integration in the GitHub UI
- Gets its own webhook secret configured once at the App level
- Can generate short-lived installation tokens if we ever want the agent to act through the App identity (optional — we can keep using the PAT for now)

The App is used purely as a webhook delivery mechanism. The agent continues to use its existing `seb-writes-code` PAT for all git and API operations.

## Architecture

```
GitHub Event (e.g. issue.assigned)
    │
    ▼
GitHub App Webhook ──POST──▶ Public URL (e.g. seb.example.com/webhooks/github)
    │
    ▼
NanoClaw HTTP Server (src/webhooks.ts)
    │  1. Verify HMAC-SHA256 signature
    │  2. Parse event type + payload
    │  3. Filter: is this relevant to us?
    │  4. Format as NewMessage
    │  5. Store in SQLite via storeMessage()
    ▼
Existing message loop picks it up (2s poll)
    │
    ▼
Agent processes in container (same as WhatsApp/Telegram messages)
```

### What changes

| Component | Change |
|-----------|--------|
| `src/webhooks.ts` | **New file.** HTTP server with webhook endpoint, signature verification, event filtering, message formatting. |
| `src/index.ts` | Start webhook server alongside existing channels. |
| `src/config.ts` | Add `WEBHOOK_PORT`, `WEBHOOK_HOST` config vars. |
| `.env` | Add `GITHUB_APP_WEBHOOK_SECRET`. |
| `package.json` | No new dependencies — uses Node's built-in `http` module. |

### What doesn't change

- Container architecture (agents still run in isolated containers)
- Message processing pipeline (messages still flow through SQLite → message loop → container)
- Channel abstraction (webhook server is _not_ a Channel — it's an inbound message source only, since we don't send messages back to GitHub via webhooks)
- Agent's GitHub auth (still uses `seb-writes-code` PAT via `gh` CLI)

## Webhook Server Design

### HTTP Server

Bare Node.js `http.createServer` — no Express or other framework. Consistent with the project's philosophy of minimal dependencies.

Single endpoint: `POST /webhooks/github`

### Signature Verification

Use `@octokit/webhooks-methods` (lightweight, single-purpose) or implement manually with Node's `crypto` module:

1. Read raw request body
2. Compute `HMAC-SHA256(secret, body)`
3. Compare with `X-Hub-Signature-256` header using `crypto.timingSafeEqual`
4. Reject with 401 if mismatch

### Event Filtering

Not every GitHub event is relevant. The webhook server should filter events to avoid unnecessary agent invocations.

**Events to process:**

| Event | Action | Trigger condition |
|-------|--------|-------------------|
| `issues` | `assigned` | Assignee is `seb-writes-code` |
| `pull_request` | `review_requested` | Reviewer is `seb-writes-code` |
| `issue_comment` | `created` | On an issue/PR assigned to or authored by `seb-writes-code` |
| `pull_request_review` | `submitted` | On a PR authored by `seb-writes-code` |
| `pull_request_review_comment` | `created` | On a PR authored by `seb-writes-code` |
| `check_suite` | `completed` (failure) | On a PR authored by `seb-writes-code` |

**Events to ignore (acknowledge with 200 but don't process):**

- Events not in the table above
- Events where the actor _is_ `seb-writes-code` (don't react to own actions)
- Events on repos not relevant to the target group

### Message Formatting

Webhook payloads are converted to `NewMessage` objects with a human-readable summary:

```
sender: "github"
sender_name: "GitHub"
content: "@Seb Chris assigned you to issue cmraible/seb#15: 'Add dark mode support'"
chat_jid: <main group JID>  (or a dedicated github group JID)
```

The content should include enough context for the agent to act: repo, issue/PR number, title, who triggered it, and a link. The agent can then use `gh` to get full details.

### Routing

GitHub webhook messages need to be routed to a registered group. Options:

1. **Always route to main group** — simplest. The main group is the admin channel and has full access. This is the recommended starting point.

2. **Route by repository** — map repos to groups via config (e.g., `cmraible/seb` → main group, `cmraible/webapp` → dev-team group). Could be added later if needed.

The message is stored with `chat_jid` set to the target group's JID, and the existing message loop picks it up automatically. The `@Seb` prefix is included so the trigger pattern matches.

## Network Exposure

The webhook server needs a publicly reachable URL for GitHub to POST to. Options:

### Option A: Cloudflare Tunnel (Recommended)

- Free, production-ready, no port forwarding needed
- `cloudflared tunnel` creates a secure tunnel from the host to a Cloudflare-managed URL
- Can restrict to GitHub's webhook IP ranges via Cloudflare Access rules
- Already handles TLS termination
- Setup: `cloudflared tunnel create nanoclaw-webhooks`, configure DNS, run as systemd service

### Option B: Direct Port Exposure

- If the host already has a public IP and domain
- Open a port (e.g., 3000), configure reverse proxy (nginx/caddy) for TLS
- Simpler if infrastructure already exists

### Option C: Reverse Proxy via Existing Service

- If there's already a web server running on the host, add a location block proxying `/webhooks/github` to the local webhook server

For our setup, Cloudflare Tunnel is likely the best fit — the host is a home server without a static IP.

## GitHub App Setup

### Registration

1. Go to https://github.com/settings/apps → New GitHub App
2. App name: `seb-assistant` (or similar)
3. Homepage URL: repo URL
4. Webhook URL: the public URL (from Cloudflare Tunnel or equivalent)
5. Webhook secret: generate and store in 1Password + `.env`
6. Permissions (read-only):
   - Issues: Read
   - Pull requests: Read
   - Checks: Read (for CI failure notifications)
   - Metadata: Read (always required)
7. Subscribe to events:
   - Issues
   - Issue comment
   - Pull request
   - Pull request review
   - Pull request review comment
   - Check suite
8. Where can this app be installed: "Only on this account"
9. Generate and download private key → store in 1Password

### Installation

Install the app on `cmraible/seb` (and any other repos as needed). Can be expanded to org-wide later.

### Secrets Storage

| Secret | Location |
|--------|----------|
| Webhook secret | 1Password + `.env` (`GITHUB_APP_WEBHOOK_SECRET`) |
| App private key | 1Password (only needed if we want installation tokens later) |
| App ID | `.env` (`GITHUB_APP_ID`) — not sensitive |

## Implementation Plan

### Phase 1: Webhook Server + Event Routing (MVP)

1. Add `src/webhooks.ts` — HTTP server, signature verification, event parsing
2. Add event-to-message formatting for the 6 event types listed above
3. Wire into `src/index.ts` startup
4. Add config vars to `src/config.ts`
5. Route all GitHub messages to the main group
6. Test with a smee.io proxy during development, then switch to production URL

### Phase 2: Network Setup

1. Set up Cloudflare Tunnel (or alternative) on the host
2. Register the GitHub App with the production webhook URL
3. Install on target repos
4. Verify end-to-end: assign issue → agent receives message → agent responds

### Phase 3: Refinements (Future)

- Per-repo routing to different groups
- Installation token support (act as the App instead of PAT)
- Webhook delivery health monitoring (GitHub shows delivery status in App settings)
- Rate limiting / deduplication for noisy repos

## Security Considerations

- **Signature verification is mandatory** — reject all unsigned or incorrectly signed requests
- **Webhook secret** stored in 1Password and `.env`, never in code or git
- **No new attack surface on the agent** — webhook messages enter the same pipeline as WhatsApp/Telegram messages, processed in an isolated container
- **Read-only App permissions** — the App itself has no write access to repos; it only receives events
- **Cloudflare Tunnel** avoids opening ports directly on the host
- **Self-notification loop prevention** — events triggered by `seb-writes-code` are filtered out to prevent the agent from reacting to its own actions

## Open Questions

1. **Dedicated group or main group?** Should GitHub events go to a dedicated `github` group (with its own CLAUDE.md and memory), or to the main group? A dedicated group would keep GitHub noise separate from admin tasks, but adds complexity.

2. **Which repos?** Start with just `cmraible/seb`, or install org-wide from day one?

3. **CI failure handling** — when a check fails on the agent's PR, should it automatically attempt a fix, or just notify and wait for instructions?

4. **Rate limiting** — if a repo gets a burst of activity (e.g., mass issue labeling), should we debounce/batch webhook messages to avoid overwhelming the agent?

5. **Cloudflare Tunnel vs. alternatives** — is Cloudflare Tunnel acceptable, or is there a preferred networking setup?
