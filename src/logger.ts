import fs from 'fs';
import path from 'path';
import pino from 'pino';

// JSON log file for structured log viewers (logdy, etc.)
const LOG_DIR = path.resolve(process.cwd(), 'logs');
const JSON_LOG_PATH = path.join(LOG_DIR, 'nanoclaw.json.log');

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty',
        options: { colorize: true },
        level: process.env.LOG_LEVEL || 'info',
      },
      {
        target: 'pino/file',
        options: { destination: JSON_LOG_PATH, mkdir: true },
        level: process.env.LOG_LEVEL || 'info',
      },
    ],
  },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});

/** Get the current log level */
export function getLogLevel(): string {
  return logger.level;
}
