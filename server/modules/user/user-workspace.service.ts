import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, normalizeProjectPath } from '@/shared/utils.js';
import logger from '@/shared/logger.js';
const log = logger.child({ module: 'user-workspace' });

/**
 * Root directory holding every user's fixed working directory.
 *
 * Resolved from `RDCLI_USER_ROOT` when configured; otherwise falls back to
 * `~/.rdcli/users` (same location family as `~/.rdcli/auth.db`). Each user
 * gets exactly one workspace at `<root>/<userId>`.
 *
 * Reads the environment lazily so tests can point the root at a temp
 * directory after import; `RDCLI_USER_ROOT` captures the value once for
 * composition-time wiring.
 */
export function getUserRootDir(): string {
  return path.resolve(
    process.env.RDCLI_USER_ROOT || path.join(os.homedir(), '.rdcli', 'users'),
  );
}

export const RDCLI_USER_ROOT = getUserRootDir();

/**
 * Builds the absolute workspace path for a numeric user id.
 *
 * The id segment must be a positive integer so it can never traverse outside
 * the user root (e.g. `../` or absolute-path segments).
 */
export function buildUserWorkspacePath(userRootPath: string, userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError('Invalid user id', {
      code: 'INVALID_USER_ID',
      statusCode: 400,
    });
  }

  return path.join(userRootPath, String(userId));
}

/** Absolute workspace path for a user under the configured user root. */
export function getUserWorkspacePath(userId: number): string {
  return buildUserWorkspacePath(RDCLI_USER_ROOT, userId);
}

/**
 * Maps a filesystem path back to the owning user id, or null when the path is
 * outside the user root.
 *
 * Pure and side-effect free: shared by the provider session synchronizers
 * (attribution + out-of-root skipping) and the ownership backfill migration.
 * Only direct children of the user root whose name is a positive integer are
 * recognized; the root itself, siblings, and non-numeric segments return null.
 */
export function resolveUserIdFromWorkspacePath(
  candidatePath: string,
  userRootPath?: string,
): number | null {
  const normalizedPath = normalizeProjectPath(candidatePath);
  if (!normalizedPath) {
    return null;
  }

  const resolvedUserRoot = userRootPath ?? getUserRootDir();
  const relativePath = path.relative(path.resolve(resolvedUserRoot), path.resolve(normalizedPath));
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  const firstSegment = relativePath.split(path.sep)[0] ?? '';
  if (!/^\d+$/.test(firstSegment)) {
    return null;
  }

  const userId = Number(firstSegment);
  return userId > 0 ? userId : null;
}

type UserWorkspaceFileSystem = {
  access(candidatePath: string): Promise<void>;
  mkdir(directoryPath: string, options?: { recursive?: boolean }): Promise<unknown>;
  realpath(candidatePath: string): Promise<string>;
  lstat(candidatePath: string): Promise<{ isSymbolicLink(): boolean }>;
  readlink(candidatePath: string): Promise<string>;
};

type UserWorkspaceDependencies = {
  userRootPath: string;
  fileSystem: UserWorkspaceFileSystem;
  projects: {
    createProjectPath(projectPath: string, customProjectName: string | null, userId?: number): unknown;
  };
  logWarn(message: string, error?: unknown): void;
};

/**
 * Owns all per-user workspace workflows: idempotent directory creation, the
 * single fixed project row per user, and symlink-aware path containment
 * validation. The service never imports the Database module; repositories
 * arrive through the injected `projects` boundary.
 */
export function createUserWorkspaceService(dependencies: UserWorkspaceDependencies) {
  const { userRootPath } = dependencies;

  /** Creates (idempotently) and returns the user's workspace directory. */
  async function ensureUserWorkspace(userId: number): Promise<string> {
    const workspacePath = buildUserWorkspacePath(userRootPath, userId);

    // ── Diagnostic: report the env + fs state before creating ───────────
    log.info('[user-workspace] ensureUserWorkspace userId=%d -> path=%s', userId, workspacePath);
    try {
      const parentStat = fs.statSync(path.dirname(workspacePath));
      log.info('[user-workspace] parent dir stat: mode=%s uid=%s gid=%s',
        (parentStat.mode & 0o777).toString(8), parentStat.uid, parentStat.gid);
    } catch (err) {
      log.warn('[user-workspace] cannot stat parent dir %s: %s',
        path.dirname(workspacePath),
        err instanceof Error ? err.message : String(err));
    }

    try {
      await dependencies.fileSystem.mkdir(workspacePath, { recursive: true });
      log.info('[user-workspace] ensureUserWorkspace userId=%d: directory ensured at %s', userId, workspacePath);
    } catch (err) {
      log.error('[user-workspace] ensureUserWorkspace userId=%d: FAILED to create %s — %s',
        userId, workspacePath,
        err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err));
      throw err;
    }

    return workspacePath;
  }

  /**
   * Creates the user's workspace directory and its single fixed project row.
   * The `active_conflict` outcome means the row already exists — exactly the
   * idempotent success this workflow wants.
   */
  async function ensureUserWorkspaceProject(
    userId: number,
    customName?: string | null,
  ): Promise<string> {
    const workspacePath = await ensureUserWorkspace(userId);
    dependencies.projects.createProjectPath(
      workspacePath,
      customName ?? '我的工作区',
      userId,
    );
    return workspacePath;
  }

  /**
   * Validates that a candidate path resolves inside the user's workspace,
   * mirroring `validateWorkspacePath` (realpath + symlink handling) but against
   * the per-user root instead of the global `WORKSPACES_ROOT`.
   */
  async function validatePathWithinUserRoot(
    userId: number,
    candidatePath: string,
  ): Promise<WorkspacePathValidationResult> {
    try {
      const normalizedCandidate = normalizeProjectPath(candidatePath);
      if (!normalizedCandidate) {
        return {
          valid: false,
          error: 'Workspace path is required',
        };
      }

      const absolutePath = path.resolve(normalizedCandidate);
      let resolvedPath = normalizeProjectPath(absolutePath);
      try {
        await dependencies.fileSystem.access(absolutePath);
        resolvedPath = normalizeProjectPath(await dependencies.fileSystem.realpath(absolutePath));
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== 'ENOENT') {
          throw fileError;
        }

        const parentPath = path.dirname(absolutePath);
        try {
          const parentRealPath = await dependencies.fileSystem.realpath(parentPath);
          resolvedPath = normalizeProjectPath(path.join(parentRealPath, path.basename(absolutePath)));
        } catch (parentError) {
          const parentFileError = parentError as NodeJS.ErrnoException;
          if (parentFileError.code !== 'ENOENT') {
            throw parentFileError;
          }
        }
      }

      const workspacePath = buildUserWorkspacePath(userRootPath, userId);
      let resolvedWorkspaceRoot = normalizeProjectPath(workspacePath);
      try {
        resolvedWorkspaceRoot = normalizeProjectPath(
          await dependencies.fileSystem.realpath(workspacePath),
        );
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== 'ENOENT') {
          throw fileError;
        }
      }

      if (
        !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
        && resolvedPath !== resolvedWorkspaceRoot
      ) {
        return {
          valid: false,
          error: 'Workspace path must be within your workspace directory',
        };
      }

      try {
        await dependencies.fileSystem.access(absolutePath);
        const pathStats = await dependencies.fileSystem.lstat(absolutePath);
        if (pathStats.isSymbolicLink()) {
          const symlinkTarget = await dependencies.fileSystem.readlink(absolutePath);
          const resolvedSymlinkPath = path.resolve(path.dirname(absolutePath), symlinkTarget);
          const realSymlinkPath = await dependencies.fileSystem.realpath(resolvedSymlinkPath);
          if (
            !realSymlinkPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)
            && realSymlinkPath !== resolvedWorkspaceRoot
          ) {
            return {
              valid: false,
              error: 'Symlink target is outside your workspace directory',
            };
          }
        }
      } catch (error) {
        const fileError = error as NodeJS.ErrnoException;
        if (fileError.code !== 'ENOENT') {
          throw fileError;
        }
      }

      return {
        valid: true,
        resolvedPath,
      };
    } catch (error) {
      return {
        valid: false,
        error: `Path validation failed: ${(error as Error).message}`,
      };
    }
  }

  return {
    ensureUserWorkspace,
    ensureUserWorkspaceProject,
    validatePathWithinUserRoot,
  };
}

export type UserWorkspaceService = ReturnType<typeof createUserWorkspaceService>;
