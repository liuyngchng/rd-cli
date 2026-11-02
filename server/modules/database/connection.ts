/**
 * Database connection management.
 *
 * Owns the single SQLite connection used across all repositories.
 * Handles path resolution, directory creation, legacy database migration,
 * and eager app_config bootstrap so the auth middleware can read the
 * JWT secret before the full schema is applied.
 *
 * Consumers should never create their own Database instance — they use
 * `getConnection()` to obtain the shared singleton.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { APP_CONFIG_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import { debug } from '@/shared/debug.js';
import logger from '@/shared/logger.js';

const log = logger.child({ module: 'database' });

const getErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the database file path from environment or falls back
 * to the legacy location inside the server/database/ folder.
 *
 * Priority:
 *   1. DATABASE_PATH environment variable (set by cli.js or load-env-vars.js)
 *   2. Legacy path: server/database/auth.db
 */
function resolveDatabasePath(): string {
    // process.env.DATABASE_PATH is set by load-env-vars.js to either the .env value or a default(~/.rdcli/auth.db) in the user's home directory. 
    return process.env.DATABASE_PATH || resolveLegacyDatabasePath();
}

/**
 * Resolves the legacy database path (always inside server/database/).
 * Used for the one-time migration to the new external location.
 */
function resolveLegacyDatabasePath(): string {
  const serverDir = path.resolve(__dirname, '..', '..', '..');
  return path.join(serverDir, 'database', 'auth.db');
}

// ---------------------------------------------------------------------------
// Directory & migration helpers
// ---------------------------------------------------------------------------

function ensureDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log.info('Created database directory: %s', dir);
  }
}

/**
 * If the database was moved to an external location (e.g. ~/.rdcli/)
 * but the user still has a legacy auth.db inside the install directory,
 * copy it to the new location as a one-time migration.
 */
function migrateLegacyDatabase(targetPath: string): void {
  const legacyPath = resolveLegacyDatabasePath();

  if (targetPath === legacyPath) return;
  if (fs.existsSync(targetPath)) return;
  if (!fs.existsSync(legacyPath)) return;

  try {
    fs.copyFileSync(legacyPath, targetPath);
    log.info('Migrated legacy database', { from: legacyPath, to: targetPath });


    // copy the write-ahead log and shared memory files (auth.db-wal, auth.db-shm) if they exist, to preserve any uncommitted transactions
    for (const suffix of ['-wal', '-shm']) {
      const src = legacyPath + suffix;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetPath + suffix);
      }
    }
  } catch (err: any) {
    log.error('Could not migrate legacy database', { error: err.message });
  }
}


// ---------------------------------------------------------------------------
// Singleton connection
// ---------------------------------------------------------------------------

let instance: Database.Database | null = null;

/**
 * Returns the shared database connection, creating it on first call.
 *
 * The first invocation:
 *   1. Resolves the target database path
 *   2. Ensures the parent directory exists
 *   3. Migrates from the legacy install-directory path if needed
 *   4. Opens the SQLite connection
 *   5. Eagerly creates the app_config table (auth reads JWT secret at import time)
 *   6. Logs the database location
 */
export function getConnection(): Database.Database {
  if (instance) return instance;

  const dbPath = resolveDatabasePath();
  debug('getConnection: opening database at', dbPath);

  // ── Diagnostic: environment + permission health ────────────────────────
  // These fire once per process and are meant to make container permission
  // problems (bind-mount uid mismatch, read-only volume, missing home dir)
  // visible in `docker logs` without any extra tooling.
  log.info('[db] getConnection: DATABASE_PATH=%s', dbPath);
  try {
    log.info('[db] getConnection: process uid=%s gid=%s home=%s',
      typeof process.getuid === 'function' ? process.getuid() : '<n/a>',
      typeof process.getgid === 'function' ? process.getgid() : '<n/a>',
      os.homedir());
  } catch (err) {
    log.warn('[db] getConnection: could not read uid/gid: %s', getErrorMessage(err));
  }

  ensureDatabaseDirectory(dbPath);

  // Report directory + file ownership/permissions before opening.
  const dbDir = path.dirname(dbPath);
  try {
    const dirStat = fs.statSync(dbDir);
    log.info('[db] getConnection: dbDir=%s mode=%s uid=%s gid=%s',
      dbDir,
      (dirStat.mode & 0o777).toString(8),
      dirStat.uid,
      dirStat.gid,
    );
    try {
      fs.accessSync(dbDir, fs.constants.W_OK | fs.constants.R_OK);
      log.info('[db] getConnection: dbDir is readable + writable by current user');
    } catch (err) {
      log.error('[db] getConnection: dbDir is NOT readable/writable by current user: %s', getErrorMessage(err));
    }
  } catch (err) {
    log.error('[db] getConnection: cannot stat dbDir %s: %s', dbDir, getErrorMessage(err));
  }

  migrateLegacyDatabase(dbPath);

  if (fs.existsSync(dbPath)) {
    try {
      const fileStat = fs.statSync(dbPath);
      log.info('[db] getConnection: existing db file mode=%s uid=%s gid=%s size=%d',
        (fileStat.mode & 0o777).toString(8),
        fileStat.uid,
        fileStat.gid,
        fileStat.size,
      );
      try {
        fs.accessSync(dbPath, fs.constants.W_OK | fs.constants.R_OK);
        log.info('[db] getConnection: existing db file is readable + writable by current user');
      } catch (err) {
        log.error('[db] getConnection: existing db file is NOT readable/writable: %s', getErrorMessage(err));
      }
    } catch (err) {
      log.warn('[db] getConnection: cannot stat existing db file: %s', getErrorMessage(err));
    }
  } else {
    log.info('[db] getConnection: db file does not exist yet — will be created on open');
  }

  debug('getConnection: creating Database instance (loading better-sqlite3 native binding)');
  instance = new Database(dbPath);

  // WAL mode allows concurrent reads with a single writer, which is essential
  // when the server shares the database with other processes (e.g. the Electron
  // main process or a second server instance). Without WAL, readers block
  // writers and vice versa — "database is locked" (SQLITE_BUSY) is common on
  // Windows where file-lock semantics differ from POSIX.
  instance.pragma('journal_mode = WAL');

  // SQLITE_BUSY is especially likely during startup when the previous server
  // instance may still be flushing its WAL. A busy_timeout tells SQLite to
  // retry for up to 5 seconds instead of failing immediately.
  instance.pragma('busy_timeout = 5000');

  debug('getConnection: Database instance created');

  // app_config must exist immediately — the auth middleware reads
  // the JWT secret at module-load time, before initializeDatabase() runs.
  instance.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
  debug('getConnection: app_config table ensured');

  return instance;
}

/**
 * Returns the resolved database file path without opening a connection.
 * Useful for diagnostics and CLI status commands.
 */
export function getDatabasePath(): string {
  return resolveDatabasePath();
}

/**
 * Closes the database connection and clears the singleton.
 *
 * Before closing, forces a WAL checkpoint so that all pending writes are
 * flushed to the main database file. This prevents "database is locked" errors
 * during restart (common on Windows) and ensures a clean state for the next
 * process that opens the database.
 */
export function closeConnection(): void {
  if (instance) {
    try {
      // Passive checkpoint: writes any committed frames from the WAL back into
      // the main database file. A busy_timeout is set so this won't fail on
      // transient locks.
      instance.pragma('wal_checkpoint(PASSIVE)');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('WAL checkpoint failed during close: %s', message);
    }
    try {
      instance.close();
      instance = null;
      log.info('Database connection closed');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Error closing database connection: %s', message);
      instance = null;
    }
  }
}
