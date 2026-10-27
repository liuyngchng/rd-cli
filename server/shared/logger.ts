/**
 * Centralized pino logger with a console-compatible facade.
 *
 * Writes two streams:
 *   1. Console (stdout) — pretty-printed, colorized, human-readable.
 *   2. File          — daily rolling under ~/.rdcli/logs/, 30-day retention.
 *
 * The exported object's `info` / `warn` / `error` / `debug` methods accept the
 * same variadic arguments as `console.log` / `console.warn` / `console.error`,
 * so existing call sites keep working unchanged:
 *
 *   logger.info('Server started');
 *   logger.info('user: %s, action: %s', username, action);
 *   logger.error('Something went wrong:', err);
 *   logger.warn('Migrated legacy database', { from, to });
 *
 * Arguments are formatted with `util.format` (exactly like `console.*`) before
 * being handed to pino, which then serializes the result to both streams.
 * When the first argument to `error` is an `Error`, it is attached as a
 * structured `err` field so the file output keeps a machine-readable error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Log directory & retention
// ---------------------------------------------------------------------------

const LOG_DIR = path.join(os.homedir(), '.rdcli', 'logs');
const RETENTION_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function ensureLogDir(): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // Best-effort — if we can't create the directory, file streaming will
    // fail but the console stream continues working.
  }
}

function cleanupOldLogs(): void {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const cutoff = Date.now() - RETENTION_DAYS * ONE_DAY_MS;
    for (const file of files) {
      const fullPath = path.join(LOG_DIR, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isFile() && stat.mtimeMs < cutoff) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // Individual file deletion is best-effort.
        }
      }
    }
  } catch {
    // No-op — cleanup is best-effort.
  }
}

ensureLogDir();
cleanupOldLogs();

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const level = process.env.RDCLI_LOG_LEVEL || 'info';

const pinoLogger = pino(
  { level },
  pino.multistream([
    // Console: pretty-printed, colorized, human-readable.
    {
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{msg}',
        },
      }),
    },
    // File: daily rolling, 30-day retention, human-readable timestamps.
    {
      stream: pino.transport({
        pipeline: [
          {
            target: 'pino-pretty',
            options: {
              colorize: false,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
              ignore: 'pid,hostname',
              messageFormat: '{msg}',
            },
          },
          {
            target: 'pino-roll',
            options: {
              file: path.join(LOG_DIR, 'server.log'),
              frequency: 'daily',
              mkdir: true,
            },
          },
        ],
      }),
    },
  ]),
);

// ---------------------------------------------------------------------------
// Console-compatible facade
// ---------------------------------------------------------------------------

function toMessage(args: unknown[]): string {
  return util.format(...args);
}

export interface RdCliLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  /** Exposes the underlying pino level, e.g. 'info' or 'debug'. */
  readonly level: string;
  /** Create a child logger that adds the given bindings to every log line. */
  child(bindings: Record<string, string>): RdCliLogger;
}

function createFacade(pinoInstance: pino.Logger): RdCliLogger {
  return {
    info(...args: unknown[]): void {
      pinoInstance.info(toMessage(args));
    },

    warn(...args: unknown[]): void {
      pinoInstance.warn(toMessage(args));
    },

    error(...args: unknown[]): void {
      if (args[0] instanceof Error) {
        const [err, ...rest] = args;
        pinoInstance.error({ err }, toMessage(rest));
        return;
      }
      pinoInstance.error(toMessage(args));
    },

    debug(...args: unknown[]): void {
      pinoInstance.debug(toMessage(args));
    },

    get level(): string {
      return pinoInstance.level;
    },

    child(bindings: Record<string, string>): RdCliLogger {
      return createFacade(pinoInstance.child(bindings));
    },
  };
}

const logger: RdCliLogger = createFacade(pinoLogger);

export default logger;