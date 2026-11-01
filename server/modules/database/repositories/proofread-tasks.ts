/**
 * Proofread tasks repository.
 *
 * Manages asynchronous proofreading tasks submitted via the external API.
 * Each task goes through: pending → processing → completed / failed.
 */

import { getConnection } from '@/modules/database/connection.js';

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type ProofreadTaskRow = {
  task_id: string;
  user_id: number;
  status: TaskStatus;
  file_name: string;
  file_size: number;
  file_path: string | null;
  additional_instructions: string | null;
  callback_url: string | null;
  session_id: string | null;
  result_text: string | null;
  result_json: string | null;
  tokens_json: string | null;
  error_message: string | null;
  last_queried_at: string | null;
  created_at: string;
  updated_at: string;
};

type CreateTaskInput = {
  taskId: string;
  userId: number;
  fileName: string;
  fileSize: number;
  filePath?: string;
  additionalInstructions?: string;
  callbackUrl?: string;
};

const TASK_COLUMNS = [
  'task_id',
  'user_id',
  'status',
  'file_name',
  'file_size',
  'file_path',
  'additional_instructions',
  'callback_url',
  'session_id',
  'result_text',
  'result_json',
  'tokens_json',
  'error_message',
  'last_queried_at',
  'created_at',
  'updated_at',
].join(', ');

function rowToTask(row: Record<string, unknown>): ProofreadTaskRow {
  return {
    task_id: row.task_id as string,
    user_id: row.user_id as number,
    status: row.status as TaskStatus,
    file_name: row.file_name as string,
    file_size: row.file_size as number,
    file_path: row.file_path as string | null,
    additional_instructions: row.additional_instructions as string | null,
    callback_url: row.callback_url as string | null,
    session_id: row.session_id as string | null,
    result_text: row.result_text as string | null,
    result_json: row.result_json as string | null,
    tokens_json: row.tokens_json as string | null,
    error_message: row.error_message as string | null,
    last_queried_at: row.last_queried_at as string | null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

export const proofreadTasksDb = {
  /** Creates a new proofread task in pending state. */
  createTask(input: CreateTaskInput): ProofreadTaskRow {
    const db = getConnection();
    db.prepare(
      `INSERT INTO proofread_tasks (task_id, user_id, status, file_name, file_size, file_path, additional_instructions, callback_url)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).run(
      input.taskId,
      input.userId,
      input.fileName,
      input.fileSize,
      input.filePath ?? null,
      input.additionalInstructions ?? null,
      input.callbackUrl ?? null,
    );
    return proofreadTasksDb.getTask(input.taskId)!;
  },

  /** Returns a single task by ID, or undefined. */
  getTask(taskId: string): ProofreadTaskRow | undefined {
    const db = getConnection();
    const row = db
      .prepare(`SELECT ${TASK_COLUMNS} FROM proofread_tasks WHERE task_id = ?`)
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : undefined;
  },

  /** Moves a task to processing status if it is still pending. Returns true if the transition happened. */
  startProcessing(taskId: string): boolean {
    const db = getConnection();
    const result = db.prepare(
      `UPDATE proofread_tasks SET status = 'processing', updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ? AND status = 'pending'`
    ).run(taskId);
    return result.changes > 0;
  },

  /** Records completion with result text, tokens, and optional session id. */
  setCompleted(
    taskId: string,
    resultText: string,
    tokens: Record<string, number>,
    sessionId?: string,
    resultJson?: string,
  ): void {
    const db = getConnection();
    db.prepare(
      `UPDATE proofread_tasks SET
         status = 'completed',
         result_text = ?,
         tokens_json = ?,
         session_id = COALESCE(?, session_id),
         result_json = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`
    ).run(resultText, JSON.stringify(tokens), sessionId ?? null, resultJson ?? null, taskId);
  },

  /** Records failure. */
  setFailed(taskId: string, errorMessage: string, sessionId?: string): void {
    const db = getConnection();
    db.prepare(
      `UPDATE proofread_tasks SET
         status = 'failed',
         error_message = ?,
         session_id = COALESCE(?, session_id),
         updated_at = CURRENT_TIMESTAMP
       WHERE task_id = ?`
    ).run(errorMessage, sessionId ?? null, taskId);
  },

  /** Lists tasks for a user, optionally filtered by status, most recent first. */
  listByUser(userId: number, options?: { statuses?: TaskStatus[]; limit?: number }): ProofreadTaskRow[] {
    const limit = options?.limit ?? 50;
    const statuses = options?.statuses;

    const db = getConnection();
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(', ');
      const rows = db
        .prepare(
          `SELECT ${TASK_COLUMNS} FROM proofread_tasks
           WHERE user_id = ? AND status IN (${placeholders})
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(userId, ...statuses, limit) as Record<string, unknown>[];
      return rows.map(rowToTask);
    }

    const rows = db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM proofread_tasks
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map(rowToTask);
  },

  /** Marks a task as cancelled. Only pending or processing tasks can be cancelled. */
  cancelTask(taskId: string): boolean {
    const db = getConnection();
    const result = db
      .prepare(
        `UPDATE proofread_tasks SET
           status = 'cancelled',
           error_message = COALESCE(error_message, '任务已撤销'),
           updated_at = CURRENT_TIMESTAMP
         WHERE task_id = ? AND status IN ('pending', 'processing')`
      )
      .run(taskId);
    return result.changes > 0;
  },

  /**
   * Returns file paths of expired tasks with a stored upload file.
   *
   * Called by the cleanup scheduler before the DB rows are pruned, so the
   * caller can remove the on-disk .docx files first.
   */
  listExpiredTaskFiles(retentionDays: number): Array<{ task_id: string; file_path: string }> {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT task_id, file_path
         FROM proofread_tasks
         WHERE file_path IS NOT NULL
           AND file_path <> ''
           AND datetime(updated_at) < datetime('now', ?)`
      )
      .all(`-${retentionDays} days`) as Array<{ task_id: string; file_path: string }>;
    return rows;
  },

  /** Deletes tasks older than the given number of days. Returns count removed. */
  cleanupOlderThan(retentionDays: number): number {
    const db = getConnection();
    const result = db
      .prepare(
        `DELETE FROM proofread_tasks
         WHERE datetime(updated_at) < datetime('now', ?)`
      )
      .run(`-${retentionDays} days`);
    return result.changes;
  },

  /** Returns the number of tasks currently being processed for a user. */
  countProcessingByUser(userId: number): number {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM proofread_tasks
         WHERE user_id = ? AND status = 'processing'`
      )
      .get(userId) as { count: number } | undefined;
    return row?.count ?? 0;
  },

};