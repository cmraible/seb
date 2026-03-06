import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger (required by env.ts)
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock readEnvFile to avoid filesystem access
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Helper: set env vars, reset modules, and dynamically import config
async function loadConfigWith(
  env: Record<string, string>,
  envFileValues?: Record<string, string>,
) {
  // Set env vars
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  // Optionally mock readEnvFile to return specific values
  if (envFileValues) {
    const { readEnvFile } = await import('./env.js');
    (readEnvFile as ReturnType<typeof vi.fn>).mockReturnValue(envFileValues);
  }

  vi.resetModules();
  return import('./config.js');
}

// Track env vars we set so we can clean them up
const envVarsToClean = [
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CONTAINER_IMAGE',
  'CONTAINER_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'IDLE_TIMEOUT',
  'MAX_CONCURRENT_CONTAINERS',
  'TZ',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ONLY',
];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of envVarsToClean) {
    delete process.env[key];
  }
});

describe('config', () => {
  describe('ASSISTANT_NAME', () => {
    it('defaults to Andy', async () => {
      const config = await loadConfigWith({});
      expect(config.ASSISTANT_NAME).toBe('Andy');
    });

    it('uses process.env value when set', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Seb' });
      expect(config.ASSISTANT_NAME).toBe('Seb');
    });

    it('falls back to .env file value', async () => {
      const config = await loadConfigWith({}, { ASSISTANT_NAME: 'Bot' });
      expect(config.ASSISTANT_NAME).toBe('Bot');
    });

    it('process.env takes precedence over .env file', async () => {
      const config = await loadConfigWith(
        { ASSISTANT_NAME: 'FromEnv' },
        { ASSISTANT_NAME: 'FromFile' },
      );
      expect(config.ASSISTANT_NAME).toBe('FromEnv');
    });
  });

  describe('ASSISTANT_HAS_OWN_NUMBER', () => {
    it('defaults to false', async () => {
      const config = await loadConfigWith({});
      expect(config.ASSISTANT_HAS_OWN_NUMBER).toBe(false);
    });

    it('is true when set to "true"', async () => {
      const config = await loadConfigWith({
        ASSISTANT_HAS_OWN_NUMBER: 'true',
      });
      expect(config.ASSISTANT_HAS_OWN_NUMBER).toBe(true);
    });

    it('is false for any other value', async () => {
      const config = await loadConfigWith({
        ASSISTANT_HAS_OWN_NUMBER: 'yes',
      });
      expect(config.ASSISTANT_HAS_OWN_NUMBER).toBe(false);
    });
  });

  describe('numeric configs', () => {
    it('CONTAINER_TIMEOUT defaults to 1800000', async () => {
      const config = await loadConfigWith({});
      expect(config.CONTAINER_TIMEOUT).toBe(1800000);
    });

    it('CONTAINER_TIMEOUT uses env value', async () => {
      const config = await loadConfigWith({ CONTAINER_TIMEOUT: '60000' });
      expect(config.CONTAINER_TIMEOUT).toBe(60000);
    });

    it('CONTAINER_MAX_OUTPUT_SIZE defaults to 10MB', async () => {
      const config = await loadConfigWith({});
      expect(config.CONTAINER_MAX_OUTPUT_SIZE).toBe(10485760);
    });

    it('IDLE_TIMEOUT defaults to 1800000', async () => {
      const config = await loadConfigWith({});
      expect(config.IDLE_TIMEOUT).toBe(1800000);
    });

    it('MAX_CONCURRENT_CONTAINERS defaults to 5', async () => {
      const config = await loadConfigWith({});
      expect(config.MAX_CONCURRENT_CONTAINERS).toBe(5);
    });

    it('MAX_CONCURRENT_CONTAINERS treats 0 as falsy and falls back to 5', async () => {
      const config = await loadConfigWith({
        MAX_CONCURRENT_CONTAINERS: '0',
      });
      expect(config.MAX_CONCURRENT_CONTAINERS).toBe(5);
    });

    it('MAX_CONCURRENT_CONTAINERS clamps negative values to 1', async () => {
      const config = await loadConfigWith({
        MAX_CONCURRENT_CONTAINERS: '-3',
      });
      expect(config.MAX_CONCURRENT_CONTAINERS).toBe(1);
    });

    it('MAX_CONCURRENT_CONTAINERS falls back to 5 for NaN', async () => {
      const config = await loadConfigWith({
        MAX_CONCURRENT_CONTAINERS: 'invalid',
      });
      expect(config.MAX_CONCURRENT_CONTAINERS).toBe(5);
    });
  });

  describe('TRIGGER_PATTERN', () => {
    it('matches trigger at start of message (case-insensitive)', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Seb' });
      expect(config.TRIGGER_PATTERN.test('@Seb hello')).toBe(true);
      expect(config.TRIGGER_PATTERN.test('@seb hello')).toBe(true);
      expect(config.TRIGGER_PATTERN.test('@SEB hello')).toBe(true);
    });

    it('does not match trigger in the middle of a message', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Seb' });
      expect(config.TRIGGER_PATTERN.test('hello @Seb')).toBe(false);
    });

    it('uses word boundary to avoid partial matches', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Seb' });
      // "Sebastian" starts with "Seb" but \b should prevent matching
      // Actually \b matches between 'b' and 'a' so this WILL match at the \b
      // The pattern is ^@Seb\b — "Sebastian" has a \b after "Seb" only if
      // the next char is non-word. 'a' is a word char, so \b does NOT match.
      expect(config.TRIGGER_PATTERN.test('@Sebastian')).toBe(false);
    });

    it('matches when trigger is the entire message', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Seb' });
      expect(config.TRIGGER_PATTERN.test('@Seb')).toBe(true);
    });

    it('escapes regex special characters in name', async () => {
      const config = await loadConfigWith({ ASSISTANT_NAME: 'Bot.v2' });
      // Without escaping, "." would match any character
      expect(config.TRIGGER_PATTERN.test('@Bot.v2 hi')).toBe(true);
      expect(config.TRIGGER_PATTERN.test('@BotXv2 hi')).toBe(false);
    });
  });

  describe('CONTAINER_IMAGE', () => {
    it('defaults to nanoclaw-agent:latest', async () => {
      const config = await loadConfigWith({});
      expect(config.CONTAINER_IMAGE).toBe('nanoclaw-agent:latest');
    });

    it('uses env value when set', async () => {
      const config = await loadConfigWith({
        CONTAINER_IMAGE: 'my-image:v2',
      });
      expect(config.CONTAINER_IMAGE).toBe('my-image:v2');
    });
  });

  describe('Telegram config', () => {
    it('TELEGRAM_BOT_TOKEN defaults to empty string', async () => {
      const config = await loadConfigWith({});
      expect(config.TELEGRAM_BOT_TOKEN).toBe('');
    });

    it('TELEGRAM_ONLY defaults to false', async () => {
      const config = await loadConfigWith({});
      expect(config.TELEGRAM_ONLY).toBe(false);
    });

    it('TELEGRAM_ONLY is true when set to "true"', async () => {
      const config = await loadConfigWith({ TELEGRAM_ONLY: 'true' });
      expect(config.TELEGRAM_ONLY).toBe(true);
    });
  });

  describe('constants', () => {
    it('POLL_INTERVAL is 2000', async () => {
      const config = await loadConfigWith({});
      expect(config.POLL_INTERVAL).toBe(2000);
    });

    it('SCHEDULER_POLL_INTERVAL is 60000', async () => {
      const config = await loadConfigWith({});
      expect(config.SCHEDULER_POLL_INTERVAL).toBe(60000);
    });

    it('IPC_POLL_INTERVAL is 1000', async () => {
      const config = await loadConfigWith({});
      expect(config.IPC_POLL_INTERVAL).toBe(1000);
    });
  });

  describe('paths', () => {
    it('STORE_DIR resolves relative to cwd', async () => {
      const config = await loadConfigWith({});
      expect(config.STORE_DIR).toBe(`${process.cwd()}/store`);
    });

    it('GROUPS_DIR resolves relative to cwd', async () => {
      const config = await loadConfigWith({});
      expect(config.GROUPS_DIR).toBe(`${process.cwd()}/groups`);
    });

    it('DATA_DIR resolves relative to cwd', async () => {
      const config = await loadConfigWith({});
      expect(config.DATA_DIR).toBe(`${process.cwd()}/data`);
    });
  });
});
