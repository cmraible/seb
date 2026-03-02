# Multi-SDK Support for NanoClaw

## Context

The agent-runner is tightly coupled to the Claude Agent SDK. The user wants per-group SDK selection so different groups can use different AI providers (e.g., Opencode SDK with ChatGPT). This refactor extracts the SDK-specific logic into pluggable "runners" while keeping the IPC loop, stdin/stdout protocol, and session management shared.

## Changes

### 1. Split agent-runner into modules (pure refactor, no behavior change)

Current monolithic `container/agent-runner/src/index.ts` (~610 lines) splits into:

```
container/agent-runner/src/
  index.ts              # Thin dispatcher: read stdin, select runner, shared IPC loop
  types.ts              # ContainerInput, ContainerOutput, RunQueryResult, SdkType
  shared.ts             # writeOutput, log, readStdin, IPC helpers, MessageStream
  transcript.ts         # parseTranscript, formatTranscriptMarkdown, PreCompact hook
  runners/
    claude.ts           # Current runQuery() + Claude-specific env/hooks/MCP config
    opencode.ts         # New Opencode SDK runner
```

**Shared runner interface** (in `types.ts`):
```typescript
type SdkType = 'claude' | 'opencode';

interface RunQueryResult {
  newSessionId?: string;
  lastResumeToken?: string;  // Claude: assistant UUID, Opencode: session ID
  closedDuringQuery: boolean;
}

type RunQueryFn = (
  prompt: string,
  sessionId: string | undefined,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
) => Promise<RunQueryResult>;
```

**`index.ts`** becomes a ~60 line dispatcher: parse stdin, select runner from `runners` map, run the shared query loop (query → wait for IPC → repeat).

### 2. Add `sdk` to group config (orchestrator side)

**`src/types.ts`** — add to `ContainerConfig`:
```typescript
sdk?: SdkType;  // Default: 'claude'
```
No DB migration needed — `container_config` is already a JSON string column.

**`src/container-runner.ts`** — two changes:
- Add `sdk` field to `ContainerInput` interface
- Pass `input.sdk = group.containerConfig?.sdk || 'claude'` before writing stdin
- Add `OPENAI_API_KEY` to `readSecrets()` allowlist

### 3. Opencode runner implementation

**`container/agent-runner/src/runners/opencode.ts`**:
- Start server: `const { client } = await createOpencode()`
- Create/resume session: `client.session.create()` or `client.session.get(id)`
- Send prompt: `client.session.prompt(id, { parts, model })`
- Extract text result, emit via `writeOutput()`
- IPC follow-up loop: same pattern as Claude (wait for message, send new prompt)
- Provider/model config: read from `opencode.json` in working dir or env vars

**Opencode config**: Each group's `/workspace/group/opencode.json` can specify provider and model. Secrets (e.g., `OPENAI_API_KEY`) injected via `sdkEnv` into the server process.

### 4. Container image changes

**`container/agent-runner/package.json`** — add `@opencode-ai/sdk` dependency.

**`container/Dockerfile`** — install opencode globally:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code
RUN curl -fsSL https://opencode.ai/install | bash
```

### 5. Adding future SDKs

To add a third SDK (e.g., Aider):
1. Add to `SdkType`: `'claude' | 'opencode' | 'aider'`
2. Create `runners/aider.ts` exporting `runQuery`
3. Register in the `runners` map in `index.ts`
4. Install SDK in Dockerfile/package.json

## Implementation order

1. Create `types.ts`, `shared.ts`, `transcript.ts` — extract from `index.ts`
2. Create `runners/claude.ts` — move `runQuery()` and Claude-specific code
3. Refactor `index.ts` — thin dispatcher with shared loop
4. **Test**: verify Claude runner works identically (regression)
5. Add `sdk` to `ContainerConfig` and `ContainerInput` (orchestrator types)
6. Pass `sdk` through in `container-runner.ts`, add `OPENAI_API_KEY` to secrets
7. Create `runners/opencode.ts` — implement Opencode runner
8. Update `package.json` and `Dockerfile`
9. **Test**: configure a group with `sdk: 'opencode'` and verify end-to-end

## Verification

1. **Regression**: Send a message to any existing group → should use Claude runner as before
2. **New SDK**: Update a group's `containerConfig` to `{ sdk: 'opencode' }`, set `OPENAI_API_KEY` in `.env`, send a message → should get a ChatGPT response via Opencode
3. **Session continuity**: Send follow-up messages to both SDK types → sessions resume correctly
4. **Build**: `./container/build.sh` completes, `npm run build` compiles
