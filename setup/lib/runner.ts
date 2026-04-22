/**
 * Step runner + abort helpers for setup:auto.
 *
 * Responsibilities:
 *   - Stream-parse setup-step status blocks (`=== NANOCLAW SETUP: … ===`)
 *   - Spawn children with output tee'd to a per-step raw log (level 3)
 *   - Wrap each run in a clack spinner with live elapsed time (level 1)
 *   - Append a structured entry to the progression log (level 2) via
 *     `setup/logs.ts` when the run ends
 *   - Abort helpers (`fail`, `ensureAnswer`) used by step orchestrators
 *
 * See docs/setup-flow.md for the three-level output contract.
 */
import { spawn } from 'child_process';
import fs from 'fs';

import * as p from '@clack/prompts';
import k from 'kleur';

import * as setupLog from '../logs.js';

export type Fields = Record<string, string>;
export type Block = { type: string; fields: Fields };

export type StepResult = {
  ok: boolean;
  exitCode: number;
  blocks: Block[];
  transcript: string;
  /** The last block with a STATUS field (the terminal/result block). */
  terminal: Block | null;
};

export type QuietChildResult = {
  ok: boolean;
  exitCode: number;
  transcript: string;
  terminal: Block | null;
  blocks: Block[];
};

export type SpinnerLabels = {
  running: string;
  done: string;
  skipped?: string;
  failed?: string;
};

/**
 * Streaming parser for `=== NANOCLAW SETUP: TYPE ===` blocks. Emits each
 * block as it closes so the UI can react mid-stream (e.g. render a pairing
 * code card as soon as pair-telegram emits it, rather than after the step
 * has finished).
 */
export class StatusStream {
  private lineBuf = '';
  private current: Block | null = null;
  readonly blocks: Block[] = [];
  transcript = '';

  constructor(private readonly onBlock: (block: Block) => void) {}

  write(chunk: string): void {
    this.transcript += chunk;
    this.lineBuf += chunk;
    let idx: number;
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + 1);
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    const start = line.match(/^=== NANOCLAW SETUP: (\S+) ===/);
    if (start) {
      this.current = { type: start[1], fields: {} };
      return;
    }
    if (line.startsWith('=== END ===')) {
      if (this.current) {
        this.blocks.push(this.current);
        this.onBlock(this.current);
        this.current = null;
      }
      return;
    }
    if (!this.current) return;
    const colon = line.indexOf(':');
    if (colon === -1) return;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key) this.current.fields[key] = value;
  }
}

/**
 * Spawn a setup step as a child process. Output is tee'd to the provided
 * raw log file (level 3) and parsed for status blocks (level 2 summary).
 * The onBlock callback fires per status block as they close so the UI can
 * react mid-stream.
 */
export function spawnStep(
  stepName: string,
  extra: string[],
  onBlock: (block: Block) => void,
  rawLogPath: string,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const args = ['exec', 'tsx', 'setup/index.ts', '--step', stepName];
    if (extra.length > 0) args.push('--', ...extra);

    const child = spawn('pnpm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stream = new StatusStream(onBlock);
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${stepName} — ${new Date().toISOString()}\n\n`);

    child.stdout.on('data', (chunk: Buffer) => {
      stream.write(chunk.toString('utf-8'));
      raw.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stream.transcript += chunk.toString('utf-8');
      raw.write(chunk);
    });

    child.on('close', (code) => {
      raw.end();
      const terminal =
        [...stream.blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      const status = terminal?.fields.STATUS;
      const ok = code === 0 && (status === 'success' || status === 'skipped');
      resolve({
        ok,
        exitCode: code ?? 1,
        blocks: stream.blocks,
        transcript: stream.transcript,
        terminal,
      });
    });
  });
}

export function spawnQuiet(
  cmd: string,
  args: string[],
  rawLogPath: string,
  envOverride?: NodeJS.ProcessEnv,
): Promise<QuietChildResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: envOverride ? { ...process.env, ...envOverride } : process.env,
    });
    let transcript = '';
    const raw = fs.createWriteStream(rawLogPath, { flags: 'w' });
    raw.write(`# ${[cmd, ...args].join(' ')} — ${new Date().toISOString()}\n\n`);
    const blocks: Block[] = [];
    const stream = new StatusStream((b) => blocks.push(b));
    child.stdout.on('data', (c: Buffer) => {
      const s = c.toString('utf-8');
      transcript += s;
      stream.write(s);
      raw.write(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      transcript += c.toString('utf-8');
      raw.write(c);
    });
    child.on('close', (code) => {
      raw.end();
      const terminal =
        [...blocks].reverse().find((b) => b.fields.STATUS) ?? null;
      resolve({ ok: code === 0, exitCode: code ?? 1, transcript, terminal, blocks });
    });
  });
}

/** Run a step under a clack spinner. Teed to a per-step raw log + progression entry at the end. */
export async function runQuietStep(
  stepName: string,
  labels: SpinnerLabels,
  extra: string[] = [],
): Promise<StepResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(stepName);
  const start = Date.now();
  const result = await runUnderSpinner(labels, () =>
    spawnStep(stepName, extra, () => {}, rawLog),
  );
  const durationMs = Date.now() - start;
  writeStepEntry(stepName, result, durationMs, rawLog);
  return { ...result, rawLog, durationMs };
}

/** Run an arbitrary child under a spinner. Same raw-log + progression treatment as runQuietStep. */
export async function runQuietChild(
  logName: string,
  cmd: string,
  args: string[],
  labels: SpinnerLabels,
  opts?: {
    /** Extra fields to merge into the progression entry (on top of any status-block fields). */
    extraFields?: Record<string, string | number | boolean>;
    /** Environment overrides to pass to the child process. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<QuietChildResult & { rawLog: string; durationMs: number }> {
  const rawLog = setupLog.stepRawLog(logName);
  const start = Date.now();
  const result = await runUnderSpinner(labels, () =>
    spawnQuiet(cmd, args, rawLog, opts?.env),
  );
  const durationMs = Date.now() - start;

  const blockFields = summariseTerminalFields(result.terminal);
  const fields = { ...blockFields, ...(opts?.extraFields ?? {}) };
  const rawStatus = result.terminal?.fields.STATUS;
  const status: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  setupLog.step(logName, status, durationMs, fields, rawLog);
  return { ...result, rawLog, durationMs };
}

/** Turn a step's terminal-block fields into a concise progression-log entry. */
export function writeStepEntry(
  stepName: string,
  result: StepResult,
  durationMs: number,
  rawLog: string,
): void {
  const rawStatus = result.terminal?.fields.STATUS;
  const logStatus: 'success' | 'skipped' | 'failed' = !result.ok
    ? 'failed'
    : rawStatus === 'skipped'
      ? 'skipped'
      : 'success';
  const fields = summariseTerminalFields(result.terminal);
  setupLog.step(stepName, logStatus, durationMs, fields, rawLog);
}

/** Strip STATUS + LOG (redundant) and any oversize values from the terminal block's fields. */
export function summariseTerminalFields(block: Block | null): Record<string, string> {
  if (!block) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(block.fields)) {
    if (k === 'STATUS' || k === 'LOG') continue;
    if (v.length > 120) continue; // keep it skimmable; full value lives in the raw log
    out[k] = v;
  }
  return out;
}

async function runUnderSpinner<
  T extends { ok: boolean; transcript: string; terminal?: Block | null },
>(
  labels: SpinnerLabels,
  work: () => Promise<T>,
): Promise<T> {
  const s = p.spinner();
  const start = Date.now();
  s.start(labels.running);
  const tick = setInterval(() => {
    const elapsed = Math.round((Date.now() - start) / 1000);
    s.message(`${labels.running} ${k.dim(`(${elapsed}s)`)}`);
  }, 1000);

  const result = await work();

  clearInterval(tick);
  const elapsed = Math.round((Date.now() - start) / 1000);
  if (result.ok) {
    const isSkipped = result.terminal?.fields.STATUS === 'skipped';
    const msg = isSkipped && labels.skipped ? labels.skipped : labels.done;
    s.stop(`${msg} ${k.dim(`(${elapsed}s)`)}`);
  } else {
    const failMsg = labels.failed ?? labels.running.replace(/…$/, ' failed');
    s.stop(`${failMsg} ${k.dim(`(${elapsed}s)`)}`, 1);
    dumpTranscriptOnFailure(result.transcript);
  }
  return result;
}

export function dumpTranscriptOnFailure(transcript: string): void {
  const lines = transcript.split('\n').filter((l) => {
    if (l.startsWith('=== NANOCLAW SETUP:')) return false;
    if (l.startsWith('=== END ===')) return false;
    return true;
  });
  const tail = lines.slice(-40).join('\n').trimEnd();
  if (tail) {
    console.log();
    console.log(k.dim(tail));
    console.log();
  }
}

/**
 * Abort the setup run with a user-facing error, logging the abort to the
 * progression log. Takes the step name explicitly so callers are clear
 * about which step they're failing from — no hidden module state.
 */
export function fail(stepName: string, msg: string, hint?: string): never {
  setupLog.abort(stepName, msg);
  p.log.error(msg);
  if (hint) p.log.message(k.dim(hint));
  p.log.message(k.dim('Logs: logs/setup.log · Raw: logs/setup-steps/'));
  p.cancel('Setup aborted.');
  process.exit(1);
}

/**
 * Unwrap a clack prompt result. If the user cancelled (Ctrl-C / Esc), exit
 * gracefully. Cancel is exit 0 — it's not an abort worth logging to the
 * progression log, since the operator initiated it deliberately.
 */
export function ensureAnswer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value as T;
}
