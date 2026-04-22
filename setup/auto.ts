/**
 * Non-interactive setup driver — the step sequencer for `pnpm run setup:auto`.
 *
 * Responsibility: orchestrate the sequence of steps end-to-end and route
 * between them. The runner, spawning, status parsing, spinner, abort, and
 * prompt primitives live in `setup/lib/runner.ts`; theming in
 * `setup/lib/theme.ts`; Telegram's full flow in `setup/channels/telegram.ts`.
 *
 * Config via env:
 *   NANOCLAW_DISPLAY_NAME  how the agents address the operator — skips the
 *                          prompt. Defaults to $USER.
 *   NANOCLAW_AGENT_NAME    messaging-channel agent name (consumed by the
 *                          channel flow). The CLI scratch agent is always
 *                          "Terminal Agent".
 *   NANOCLAW_SKIP          comma-separated step names to skip
 *                          (environment|container|onecli|auth|mounts|
 *                           service|cli-agent|channel|verify)
 *
 * Timezone defaults to the host system's TZ. Run
 *   pnpm exec tsx setup/index.ts --step timezone -- --tz <zone>
 * later if autodetect is wrong.
 */
import { spawn, spawnSync } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { runTelegramChannel } from './channels/telegram.js';
import * as setupLog from './logs.js';
import { ensureAnswer, fail, runQuietChild, runQuietStep } from './lib/runner.js';
import { brandBold, brandChip } from './lib/theme.js';

const CLI_AGENT_NAME = 'Terminal Agent';
const RUN_START = Date.now();

async function main(): Promise<void> {
  printIntro();
  initProgressionLog();

  const skip = new Set(
    (process.env.NANOCLAW_SKIP ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!skip.has('environment')) {
    const res = await runQuietStep('environment', {
      running: 'Checking your system…',
      done: 'Your system looks good.',
    });
    if (!res.ok) {
      fail(
        'environment',
        "Your system doesn't look quite right.",
        'See logs/setup-steps/ for details, then retry.',
      );
    }
  }

  if (!skip.has('container')) {
    p.log.message(
      k.dim(
        'Your assistant lives in its own sandbox. It can only see what you explicitly share.',
      ),
    );
    const res = await runQuietStep('container', {
      running: 'Preparing the sandbox your assistant runs in…',
      done: 'Sandbox ready.',
      failed: "Couldn't prepare the sandbox.",
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'runtime_not_available') {
        fail(
          'container',
          "Docker isn't available.",
          'Install Docker Desktop (or start it if already installed), then retry.',
        );
      }
      if (err === 'docker_group_not_active') {
        fail(
          'container',
          "Docker was just installed but your shell doesn't know yet.",
          'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
        );
      }
      fail(
        'container',
        "Couldn't build the sandbox.",
        'If Docker has a stale cache, try: `docker builder prune -f`, then retry.',
      );
    }
    maybeReexecUnderSg();
  }

  if (!skip.has('onecli')) {
    p.log.message(
      k.dim(
        'Your assistant never gets your API keys directly. The vault adds them to approved requests as they leave the sandbox.',
      ),
    );
    const res = await runQuietStep('onecli', {
      running: "Setting up OneCLI, your agent's vault…",
      done: 'OneCLI vault ready.',
    });
    if (!res.ok) {
      const err = res.terminal?.fields.ERROR;
      if (err === 'onecli_not_on_path_after_install') {
        fail(
          'onecli',
          'OneCLI was installed but your shell needs to refresh to see it.',
          'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"`, then retry.',
        );
      }
      fail(
        'onecli',
        `Couldn't set up OneCLI (${err ?? 'unknown error'}).`,
        'Make sure curl is installed and ~/.local/bin is writable, then retry.',
      );
    }
  }

  if (!skip.has('auth')) {
    await runAuthStep();
  }

  if (!skip.has('mounts')) {
    const res = await runQuietStep(
      'mounts',
      {
        running: "Setting your assistant's access rules…",
        done: 'Access rules set.',
        skipped: 'Access rules already set.',
      },
      ['--empty'],
    );
    if (!res.ok) {
      fail('mounts', "Couldn't write access rules.");
    }
  }

  if (!skip.has('service')) {
    const res = await runQuietStep('service', {
      running: 'Starting NanoClaw in the background…',
      done: 'NanoClaw is running.',
    });
    if (!res.ok) {
      fail(
        'service',
        "Couldn't start NanoClaw.",
        'See logs/nanoclaw.error.log for details.',
      );
    }
    if (res.terminal?.fields.DOCKER_GROUP_STALE === 'true') {
      p.log.warn(
        "NanoClaw's permissions need a tweak before it can reach Docker.",
      );
      p.log.message(
        k.dim(
          '  sudo setfacl -m u:$(whoami):rw /var/run/docker.sock\n' +
            '  systemctl --user restart nanoclaw',
        ),
      );
    }
  }

  let displayName: string | undefined;
  const needsDisplayName = !skip.has('cli-agent') || !skip.has('channel');
  if (needsDisplayName) {
    const fallback = process.env.USER?.trim() || 'Operator';
    const preset = process.env.NANOCLAW_DISPLAY_NAME?.trim();
    displayName = preset || (await askDisplayName(fallback));
  }

  if (!skip.has('cli-agent')) {
    const res = await runQuietStep(
      'cli-agent',
      {
        running: 'Setting up your terminal chat…',
        done: 'Terminal chat ready. Try `pnpm run chat hi`.',
      },
      ['--display-name', displayName!, '--agent-name', CLI_AGENT_NAME],
    );
    if (!res.ok) {
      fail(
        'cli-agent',
        "Couldn't set up the terminal chat.",
        `You can retry later with \`pnpm exec tsx scripts/init-cli-agent.ts --display-name "${displayName!}" --agent-name "${CLI_AGENT_NAME}"\`.`,
      );
    }
  }

  if (!skip.has('channel')) {
    const choice = await askChannelChoice();
    if (choice === 'telegram') {
      await runTelegramChannel(displayName!);
    } else {
      p.log.info(
        "No messaging app for now. You can add one later (like Telegram, Slack, or Discord).",
      );
    }
  }

  if (!skip.has('verify')) {
    const res = await runQuietStep('verify', {
      running: 'Making sure everything works together…',
      done: "Everything's connected.",
      failed: 'A few things still need your attention.',
    });
    if (!res.ok) {
      const notes: string[] = [];
      if (res.terminal?.fields.CREDENTIALS !== 'configured') {
        notes.push('• Your Claude account isn\'t connected. Re-run setup and try again.');
      }
      const agentPing = res.terminal?.fields.AGENT_PING;
      if (agentPing && agentPing !== 'ok' && agentPing !== 'skipped') {
        notes.push(
          "• Your assistant didn't reply to a test message. " +
            'Check `logs/nanoclaw.log` for clues, then try `pnpm run chat hi`.',
        );
      }
      if (!res.terminal?.fields.CONFIGURED_CHANNELS) {
        notes.push('• Want to chat from your phone? Add a messaging app with `/add-telegram`, `/add-slack`, or `/add-discord`.');
      }
      if (notes.length > 0) {
        p.note(notes.join('\n'), "What's left");
      }
      p.outro(k.yellow('Almost there. A few things still need your attention.'));
      return;
    }
  }

  const rows: [string, string][] = [
    ['Chat in the terminal:', 'pnpm run chat hi'],
    ["See what's happening:", 'tail -f logs/nanoclaw.log'],
    ['Open Claude Code:', 'claude'],
  ];
  const labelWidth = Math.max(...rows.map(([l]) => l.length));
  const nextSteps = rows
    .map(([l, c]) => `${k.cyan(l.padEnd(labelWidth))}  ${c}`)
    .join('\n');
  p.note(nextSteps, 'Try these');
  setupLog.complete(Date.now() - RUN_START);
  p.outro(k.green("You're ready! Enjoy NanoClaw."));
}

// ─── auth step (select → branch) ────────────────────────────────────────

async function runAuthStep(): Promise<void> {
  if (anthropicSecretExists()) {
    p.log.success('Your Claude account is already connected.');
    setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
    return;
  }

  const method = ensureAnswer(
    await p.select({
      message: 'How would you like to connect to Claude?',
      options: [
        {
          value: 'subscription',
          label: 'Sign in with my Claude subscription',
          hint: 'recommended if you have Pro or Max',
        },
        {
          value: 'oauth',
          label: 'Paste an OAuth token I already have',
          hint: 'sk-ant-oat…',
        },
        {
          value: 'api',
          label: 'Paste an Anthropic API key',
          hint: 'pay-per-use via console.anthropic.com',
        },
      ],
    }),
  ) as 'subscription' | 'oauth' | 'api';
  setupLog.userInput('auth_method', method);

  if (method === 'subscription') {
    await runSubscriptionAuth();
  } else {
    await runPasteAuth(method);
  }
}

async function runSubscriptionAuth(): Promise<void> {
  p.log.step("Opening the Claude sign-in flow…");
  console.log(
    k.dim('   (a browser will open for sign-in; this part is interactive)'),
  );
  console.log();
  const start = Date.now();
  const code = await runInheritScript('bash', [
    'setup/register-claude-token.sh',
  ]);
  const durationMs = Date.now() - start;
  console.log();
  if (code !== 0) {
    setupLog.step('auth', 'failed', durationMs, {
      EXIT_CODE: code,
      METHOD: 'subscription',
    });
    fail(
      'auth',
      "Couldn't complete the Claude sign-in.",
      'Re-run setup and try again, or choose a paste option instead.',
    );
  }
  setupLog.step('auth', 'interactive', durationMs, { METHOD: 'subscription' });
  p.log.success('Claude account connected.');
}

async function runPasteAuth(method: 'oauth' | 'api'): Promise<void> {
  const label = method === 'oauth' ? 'OAuth token' : 'API key';
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';

  const answer = ensureAnswer(
    await p.password({
      message: `Paste your ${label}`,
      validate: (v) => {
        if (!v || !v.trim()) return 'Required';
        if (!v.trim().startsWith(prefix)) {
          return `Should start with ${prefix}…`;
        }
        return undefined;
      },
    }),
  );
  const token = (answer as string).trim();

  const res = await runQuietChild(
    'auth',
    'onecli',
    [
      'secrets', 'create',
      '--name', 'Anthropic',
      '--type', 'anthropic',
      '--value', token,
      '--host-pattern', 'api.anthropic.com',
    ],
    {
      running: `Saving your ${label} to your OneCLI vault…`,
      done: 'Claude account connected.',
    },
    {
      extraFields: { METHOD: method },
    },
  );
  if (!res.ok) {
    fail(
      'auth',
      `Couldn't save your ${label} to the vault.`,
      'Make sure OneCLI is running (`onecli version`), then retry.',
    );
  }
}

// ─── prompts owned by the sequencer ────────────────────────────────────

async function askDisplayName(fallback: string): Promise<string> {
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant call you?',
      placeholder: fallback,
      defaultValue: fallback,
    }),
  );
  const value = (answer as string).trim() || fallback;
  setupLog.userInput('display_name', value);
  return value;
}

async function askChannelChoice(): Promise<'telegram' | 'skip'> {
  const choice = ensureAnswer(
    await p.select({
      message: 'Want to chat with your assistant from your phone?',
      options: [
        { value: 'telegram', label: 'Yes, connect Telegram', hint: 'recommended' },
        { value: 'skip', label: 'Skip for now', hint: "I'll just use the terminal" },
      ],
    }),
  );
  setupLog.userInput('channel_choice', String(choice));
  return choice as 'telegram' | 'skip';
}

// ─── interactive / env helpers ─────────────────────────────────────────

function anthropicSecretExists(): boolean {
  try {
    const res = spawnSync('onecli', ['secrets', 'list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return false;
    return /anthropic/i.test(res.stdout ?? '');
  } catch {
    return false;
  }
}

function runInheritScript(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/**
 * After installing Docker, this process's supplementary groups are still
 * frozen from login — subsequent steps that talk to /var/run/docker.sock
 * (onecli install, service start, …) fail with EACCES even though the
 * daemon is up. Detect that and re-exec the whole driver under `sg docker`
 * so the rest of the run inherits the docker group without a re-login.
 */
function maybeReexecUnderSg(): void {
  if (process.env.NANOCLAW_REEXEC_SG === '1') return;
  if (process.platform !== 'linux') return;
  const info = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (info.status === 0) return;
  const err = `${info.stderr ?? ''}\n${info.stdout ?? ''}`;
  if (!/permission denied/i.test(err)) return;
  if (spawnSync('which', ['sg'], { stdio: 'ignore' }).status !== 0) return;

  p.log.warn('Docker socket not accessible in current group. Re-executing under `sg docker`.');
  const res = spawnSync('sg', ['docker', '-c', 'pnpm run setup:auto'], {
    stdio: 'inherit',
    env: { ...process.env, NANOCLAW_REEXEC_SG: '1' },
  });
  process.exit(res.status ?? 1);
}

// ─── intro + progression-log init ──────────────────────────────────────

function printIntro(): void {
  const isReexec = process.env.NANOCLAW_REEXEC_SG === '1';
  const isBootstrapped = process.env.NANOCLAW_BOOTSTRAPPED === '1';
  const wordmark = `${k.bold('Nano')}${brandBold('Claw')}`;

  if (isReexec) {
    p.intro(
      `${brandChip(' Welcome ')}  ${wordmark}  ${k.dim('· picking up where we left off')}`,
    );
    return;
  }

  // When we were called via nanoclaw.sh, the wordmark + subtitle were
  // already printed in bash. Just open the clack gutter with a short,
  // neutral intro so the flow continues without duplication.
  if (isBootstrapped) {
    p.intro(k.dim("Let's get you set up."));
    return;
  }

  console.log();
  console.log(`  ${wordmark}`);
  console.log(`  ${k.dim('Setting up your personal AI assistant')}`);
  p.intro(k.dim("Let's get you set up."));
}

/**
 * Bootstrap (nanoclaw.sh) normally initializes logs/setup.log and writes
 * the bootstrap entry before we even boot. If someone runs `pnpm run
 * setup:auto` directly, start a fresh progression log here so we don't
 * append to a stale one from a previous run.
 */
function initProgressionLog(): void {
  if (process.env.NANOCLAW_BOOTSTRAPPED === '1') return;
  let commit = '';
  try {
    commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // git not available or not a repo — skip
  }
  let branch = '';
  try {
    branch = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf-8',
    }).stdout.trim();
  } catch {
    // skip
  }
  setupLog.reset({
    invocation: 'setup:auto (standalone)',
    user: process.env.USER ?? 'unknown',
    cwd: process.cwd(),
    branch: branch || 'unknown',
    commit: commit || 'unknown',
  });
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  p.cancel('Setup aborted.');
  process.exit(1);
});
