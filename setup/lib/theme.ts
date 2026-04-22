/**
 * NanoClaw brand palette for the terminal.
 *
 * Colors pulled from assets/nanoclaw-logo.png:
 *   brand cyan  ≈ #2BB7CE  — the "Claw" wordmark + mascot body
 *   brand navy  ≈ #171B3B  — the dark logo background + outlines
 *
 * Rendering gates:
 *   - No TTY (piped / redirected) → plain text, no ANSI
 *   - NO_COLOR set               → plain text, no ANSI
 *   - COLORTERM truecolor/24bit  → 24-bit ANSI (exact brand cyan)
 *   - Otherwise                  → kleur's 16-color cyan (closest fallback)
 */
import k from 'kleur';

const USE_ANSI = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const TRUECOLOR =
  USE_ANSI &&
  (process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit');

export function brand(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[38;2;43;183;206m${s}\x1b[0m`;
  return k.cyan(s);
}

export function brandBold(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) return `\x1b[1;38;2;43;183;206m${s}\x1b[0m`;
  return k.bold(k.cyan(s));
}

export function brandChip(s: string): string {
  if (!USE_ANSI) return s;
  if (TRUECOLOR) {
    return `\x1b[48;2;43;183;206m\x1b[38;2;23;27;59m\x1b[1m${s}\x1b[0m`;
  }
  return k.bgCyan(k.black(k.bold(s)));
}
