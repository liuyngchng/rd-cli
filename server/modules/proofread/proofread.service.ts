import http from 'node:http';
import https from 'node:https';

import type { ProviderRuntimeWriter, ProviderRunFunction } from '@/shared/types.js';
import { appendFilesInputTag } from '@/shared/image-attachments.js';
import { AppError } from '@/shared/utils.js';
import { proofreadTasksDb as ProofreadTasksDb, sessionsDb as SessionsDb } from '@/modules/database/index.js';
import { debug, log } from '@/shared/debug.js';
import logger from '@/shared/logger.js';

const proofreadLog = logger.child({ module: 'proofread' });

type UserInfo = {
  userId: number;
  username: string;
};

type CreateProofreadSessionInput = {
  user: UserInfo;
  filePath: string;
  fileName: string;
  fileSize: number;
  additionalInstructions?: string;
  sessionId: string;
  workspacePath: string;
};

type CreateProofreadTaskInput = {
  user: UserInfo;
  filePath: string;
  fileName: string;
  fileSize: number;
  additionalInstructions?: string;
  callbackUrl?: string;
  sessionId: string;
  workspacePath: string;
};

type ProofreadSessionResult = {
  sessionId: string;
  sessionUrl: string;
};

type ProofreadTaskResult = {
  taskId: string;
  status: string;
};

type ProofreadServiceDependencies = {
  queryClaude: ProviderRunFunction;
  getSessionUrl: (sessionId: string) => string;
  proofreadTasksDb: typeof ProofreadTasksDb;
  sessionsDb: typeof SessionsDb;
  /** Aborts a running Claude session by its session id (which equals the task id). */
  abortClaudeSession: (sessionId: string) => Promise<boolean>;
};

/**
 * Writer that discards all data and merely captures the provider-native session
 * id — used for the fire-and-forget /session endpoint.
 */
class SessionIdCollector implements ProviderRuntimeWriter {
  messages: unknown[] = [];
  sessionId: string | null = null;
  userId: number;

  constructor(userId: number) {
    this.userId = userId;
  }

  send(data: unknown) {
    this.messages.push(data);
    if (!this.sessionId && typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      if (typeof record.sessionId === 'string') {
        this.sessionId = record.sessionId;
      }
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

/**
 * Writer that collects all stream messages and, when queried post-run, extracts
 * the complete assistant response as Markdown text plus token-usage statistics.
 */
class ProofreadResultCollector implements ProviderRuntimeWriter {
  messages: unknown[] = [];
  sessionId: string | null = null;
  userId: number;

  constructor(userId: number) {
    this.userId = userId;
  }

  send(data: unknown) {
    this.messages.push(data);
    if (!this.sessionId && typeof data === 'object' && data !== null) {
      const record = data as Record<string, unknown>;
      if (typeof record.sessionId === 'string') {
        this.sessionId = record.sessionId;
      }
    }
  }

  setSessionId(sessionId: string) {
    this.sessionId = sessionId;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Extracts the concatenated assistant text blocks. */
  getResultText(): string {
    const parts: string[] = [];
    for (const msg of this.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      // Normalized messages: assistant text blocks have kind='text' + role='assistant'
      if (m.kind === 'text' && m.role === 'assistant' && m.content && typeof m.content === 'string') {
        parts.push(m.content);
      }
    }
    return parts.join('\n\n');
  }

  /** True when the stream delivered at least one assistant message. */
  hasOutput(): boolean {
    return this.messages.some((msg) => {
      if (!msg || typeof msg !== 'object') return false;
      const m = msg as Record<string, unknown>;
      return m.kind === 'text' && m.role === 'assistant';
    });
  }

  /** Extracts the first SDK-level error message, if any. */
  getSdkError(): string | undefined {
    for (const msg of this.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      // Normalized error messages have kind='error' and content.
      if (m.kind === 'error' && typeof m.content === 'string') {
        return m.content;
      }
    }
    return undefined;
  }

  /** Computes total input / output token counts from stream usage data. */
  getTokenSummary(): Record<string, number> {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;

    for (const msg of this.messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      // Token budget is sent as a normalized 'status' message with tokenBudget field.
      const budget = m.tokenBudget;
      if (budget && typeof budget === 'object') {
        const b = budget as Record<string, unknown>;
        inputTokens = Math.max(inputTokens, Number(b.inputTokens ?? 0));
        outputTokens = Math.max(outputTokens, Number(b.outputTokens ?? 0));
        cacheReadTokens = Math.max(cacheReadTokens, Number(b.cacheReadTokens ?? 0));
        cacheCreationTokens = Math.max(cacheCreationTokens, Number(b.cacheCreationTokens ?? 0));
      }
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
}

/** Builds the user message for proofreading. Claude selects the standard from CLAUDE.md. */
function buildUserMessage(
  filePath: string,
  fileName: string,
  additionalInstructions?: string,
  includeMarkdownHint?: boolean,
): string {
  let message = '请校对审读这篇文档。';

  message = appendFilesInputTag(message, [
    { path: filePath, name: fileName },
  ]);

  if (includeMarkdownHint) {
    message += '\n\n请以 Markdown 格式输出审核意见。';
  }

  if (additionalInstructions && additionalInstructions.trim()) {
    message += `\n\n${additionalInstructions.trim()}`;
  }

  return message;
}

/**
 * Converts a SQLite `CURRENT_TIMESTAMP` value (UTC, no zone marker, e.g.
 * `2026-10-24 10:52:57`) into a UTC+8 (Asia/Shanghai) local-time string in the
 * same `YYYY-MM-DD HH:MM:SS` layout, e.g. `2026-10-24 18:52:57`.
 *
 * Unparseable values (or values that already carry a zone) are returned as-is.
 */
export function toLocalTimestamp(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return raw;
  const utcDate = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  if (Number.isNaN(utcDate.getTime())) return raw;
  // Date getters (getFullYear, getHours, etc.) already return local time —
  // no manual offset needed.
  const yyyy = utcDate.getFullYear();
  const MM = String(utcDate.getMonth() + 1).padStart(2, '0');
  const dd = String(utcDate.getDate()).padStart(2, '0');
  const HH = String(utcDate.getHours()).padStart(2, '0');
  const mm = String(utcDate.getMinutes()).padStart(2, '0');
  const ss = String(utcDate.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

/** Formats the current instant as a UTC+8 local timestamp (`YYYY-MM-DD HH:MM:SS`). */
export function nowLocalTimestamp(): string {
  const now = new Date();
  // new Date() is already local; format directly.
  const yyyy = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

/** Maximum number of processing tasks allowed per user. */
const MAX_PROCESSING_TASKS = 5;

/** Callback retry delays (ms) between attempts: attempt 1 → 2s, 2 → 5s, 3 → 15s. */
const CALLBACK_RETRY_DELAYS_MS = [2000, 5000, 15000];
const CALLBACK_TIMEOUT_MS = 30000;

/** Sends a single callback POST request. Resolves true on 2xx, false otherwise. */
function postCallback(callbackUrl: string, payload: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      resolve(false);
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      resolve(false);
      return;
    }

    const body = JSON.stringify(payload);
    const transport = parsed.protocol === 'https:' ? https : http;

    log('[Proofread API] Callback — request',
      JSON.stringify({
        taskId: payload.task_id,
        status: (payload.data as Record<string, unknown>)?.status,
        url: callbackUrl,
        payload,
      }));
    // Ignore TLS certificate validation so self-signed HTTPS endpoints work.
    const requestOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    };

    const req = transport.request(requestOptions, (res) => {
      // Drain the response body so the connection can be reused.
      res.resume();
      const success = res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300;
      log('[Proofread API] Callback — response',
        JSON.stringify({ taskId: payload.task_id, statusCode: res.statusCode, success }));
      resolve(success);
    });

    req.setTimeout(CALLBACK_TIMEOUT_MS, () => {
      req.destroy(new Error('Callback timeout'));
    });
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });
}

/** Delivers the task result to callbackUrl, retrying up to 3 times. */
async function deliverCallback(callbackUrl: string, payload: Record<string, unknown>): Promise<void> {
  for (let attempt = 0; attempt <= CALLBACK_RETRY_DELAYS_MS.length; attempt += 1) {
    const ok = await postCallback(callbackUrl, payload);
    if (ok) {
      debug('[Proofread] Callback delivered', `url=${callbackUrl}`);
      return;
    }
    if (attempt < CALLBACK_RETRY_DELAYS_MS.length) {
      const delay = CALLBACK_RETRY_DELAYS_MS[attempt];
      debug('[Proofread] Callback failed, retrying', `url=${callbackUrl}`, `delay=${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  proofreadLog.error('Callback failed after all retries for %s: %s', payload.task_id, callbackUrl);
}

export function createProofreadService(deps: ProofreadServiceDependencies) {
  const { queryClaude, getSessionUrl, proofreadTasksDb, sessionsDb, abortClaudeSession } = deps;

  return {
    // ── Session mode (existing, fire-and-forget) ──────────────────────────

    async createProofreadSession(
      input: CreateProofreadSessionInput,
    ): Promise<ProofreadSessionResult> {
      const {
        user,
        filePath,
        fileName,
        fileSize: _fileSize,
        additionalInstructions,
        sessionId,
        workspacePath,
      } = input;

      const userMessage = buildUserMessage(filePath, fileName, additionalInstructions);

      // Register an app session row before the provider run so that the runtime's
      // `resolveProviderSessionId` finds a row with a NULL provider_session_id and
      // starts a fresh conversation instead of treating the id as a resume target.
      sessionsDb.createAppSession(sessionId, 'claude', workspacePath, user.userId);

      const writer = new SessionIdCollector(user.userId);
      writer.setSessionId(sessionId);

      queryClaude(
        userMessage,
        {
          sessionId,
          cwd: workspacePath,
          projectPath: workspacePath,
          permissionMode: 'bypassPermissions',
          sessionSummary: `核稿: ${fileName}`,
        },
        writer,
      ).catch((error: unknown) => {
        proofreadLog.error(
          'Background Claude run failed for session %s: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
      });

      return {
        sessionId,
        sessionUrl: getSessionUrl(sessionId),
      };
    },

    // ── Async task mode (new) ─────────────────────────────────────────────

    /** Creates an async proofread task. Returns immediately with taskId. */
    async createProofreadTask(
      input: CreateProofreadTaskInput,
    ): Promise<ProofreadTaskResult> {
      const {
        user,
        filePath,
        fileName,
        fileSize,
        additionalInstructions,
        sessionId,
        workspacePath,
      } = input;

      // Enforce per-user concurrency limit.
      const processingCount = proofreadTasksDb.countProcessingByUser(user.userId);
      if (processingCount >= MAX_PROCESSING_TASKS) {
        throw new AppError(
          `同时处理的核稿任务已达上限（${MAX_PROCESSING_TASKS} 个），请等待已有任务完成后重试。`,
          { code: 'TOO_MANY_TASKS', statusCode: 429 },
        );
      }

      const task = proofreadTasksDb.createTask({
        taskId: sessionId,
        userId: user.userId,
        fileName,
        fileSize,
        filePath,
        additionalInstructions,
        callbackUrl: input.callbackUrl,
      });

      debug('[Proofread] Task created', `taskId=${task.task_id}`);

      // Kick off background processing — intentionally not awaited.
      this.executeProofreadTask(sessionId, {
        user,
        filePath,
        fileName,
        additionalInstructions,
        callbackUrl: input.callbackUrl,
        sessionId,
        workspacePath,
      }).catch(async (error: unknown) => {
        proofreadLog.error(
          'Task execution failed for %s: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
        // If setFailed wasn't called inside executeProofreadTask, set it now.
        const current = proofreadTasksDb.getTask(sessionId);
        if (current && current.status === 'processing') {
          proofreadTasksDb.setFailed(
            sessionId,
            error instanceof Error ? error.message : String(error),
          );
          await this.deliverTaskCallback(sessionId);
        }
      });

      return {
        taskId: task.task_id,
        status: task.status,
      };
    },

    /** Background execution: marks task processing, runs Claude, stores result. */
    async executeProofreadTask(
      taskId: string,
      input: {
        user: UserInfo;
        filePath: string;
        fileName: string;
        additionalInstructions?: string;
        callbackUrl?: string;
        sessionId: string;
        workspacePath: string;
      },
    ): Promise<void> {
      const { user, filePath, fileName, additionalInstructions, callbackUrl, sessionId, workspacePath } = input;

      // Atomically transition pending → processing. If the task was cancelled
      // while still pending, this returns false and we skip the Claude run.
      const started = proofreadTasksDb.startProcessing(taskId);
      if (!started) {
        debug('[Proofread] Task no longer pending, skipping execution', `taskId=${taskId}`);
        return;
      }
      debug('[Proofread] Task processing started', `taskId=${taskId}`);

      // Include Markdown hint so Claude outputs structured, parseable results.
      const userMessage = buildUserMessage(filePath, fileName, additionalInstructions, true);

      // Register an app session row before the provider run so that the runtime's
      // `resolveProviderSessionId` finds a row with a NULL provider_session_id and
      // starts a fresh conversation instead of treating the task id as a resume target.
      sessionsDb.createAppSession(sessionId, 'claude', workspacePath, user.userId);

      const writer = new ProofreadResultCollector(user.userId);
      writer.setSessionId(sessionId);

      try {
        await queryClaude(
          userMessage,
          {
            sessionId,
            cwd: workspacePath,
            projectPath: workspacePath,
            permissionMode: 'bypassPermissions',
            sessionSummary: `核稿: ${fileName}`,
          },
          writer,
        );

        // Guard: if the task was cancelled while Claude was running, the abort
        // handler already set the status to cancelled — don't overwrite it.
        const current = proofreadTasksDb.getTask(taskId);
        if (current && current.status === 'cancelled') {
          debug('[Proofread] Task was cancelled, discarding completed result', `taskId=${taskId}`);
          return;
        }

        const resultText = writer.getResultText();
        const tokens = writer.getTokenSummary();
        const capturedSessionId = writer.getSessionId() || sessionId;

        // Guard: if Claude exited without producing any assistant output, treat
        // it as a failure rather than delivering an empty "completed" callback.
        if (!writer.hasOutput() && tokens.totalTokens === 0) {
          const sdkError = writer.getSdkError();
          const message = sdkError
            ? `Claude 运行异常: ${sdkError}`
            : '核稿处理异常：Claude 未返回任何结果，可能是容器权限问题或其他运行时错误导致';
          proofreadLog.error(
            'Task %s: Claude produced no output — marking as failed %s',
            taskId,
            sdkError ? `(sdk error: ${sdkError})` : '',
          );
          proofreadTasksDb.setFailed(taskId, message, capturedSessionId);
          await this.deliverTaskCallback(taskId);
          return;
        }

        proofreadTasksDb.setCompleted(taskId, resultText, tokens, capturedSessionId);
        debug('[Proofread] Task completed', `taskId=${taskId}`, `tokens=${tokens.totalTokens}`);

        // Fire callback.
        await this.deliverTaskCallback(taskId);
      } catch (error: unknown) {
        // Guard: also check here in case abort interrupted during error handling.
        const current = proofreadTasksDb.getTask(taskId);
        if (current && current.status === 'cancelled') {
          debug('[Proofread] Task was cancelled, discarding error result', `taskId=${taskId}`);
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        const capturedSessionId = writer.getSessionId() || sessionId;
        proofreadTasksDb.setFailed(taskId, message, capturedSessionId);
        debug('[Proofread] Task failed', `taskId=${taskId}`, `error=${message}`);

        // Fire callback.
        await this.deliverTaskCallback(taskId);
      }
    },

    /**
     * Builds the callback payload from the current task row and delivers it.
     * This is invoked on every terminal state: completed, failed, cancelled.
     */
    async deliverTaskCallback(taskId: string): Promise<void> {
      const task = proofreadTasksDb.getTask(taskId);
      if (!task || !task.callback_url) return;

      const data: Record<string, unknown> = {
        status: task.status,
        file_name: task.file_name,
        file_size: task.file_size,
        created_at: toLocalTimestamp(task.created_at),
        updated_at: toLocalTimestamp(task.updated_at),
      };

      if (task.additional_instructions) {
        data.additional_instructions = task.additional_instructions;
      }

      if (task.status === 'completed') {
        data.result_text = task.result_text;
        if (task.tokens_json) {
          try { data.tokens = JSON.parse(task.tokens_json); } catch { /* skip */ }
        }
        if (task.session_id) {
          data.session_id = task.session_id;
          data.session_url = getSessionUrl(task.session_id);
        }
      } else if (task.status === 'failed' || task.status === 'cancelled') {
        data.error_message = task.error_message;
      }

      const code = task.status === 'completed'
        ? 0
        : task.status === 'cancelled'
          ? 2002
          : 2001;
      const payload: Record<string, unknown> = {
        code,
        timestamp: nowLocalTimestamp(),
        message: task.status === 'completed' ? 'success' : task.error_message ?? 'failed',
        task_id: task.task_id,
        data,
      };

      await deliverCallback(task.callback_url, payload);
    },

    /** Queries a task by id. */
    getTask(taskId: string) {
      return proofreadTasksDb.getTask(taskId);
    },

    /**
     * Cancels a proofread task. If the task is processing, the underlying
     * Claude session is aborted. Only pending and processing tasks can be
     * cancelled.
     *
     * Returns the task row on success, or undefined if the task does not exist
     * or is already in a terminal state.
     */
    async cancelTask(taskId: string) {
      const task = proofreadTasksDb.getTask(taskId);
      if (!task) return undefined;

      // Abort the Claude session if it's currently running.
      // The task id IS the session id passed to queryClaude, so the SDK's
      // activeSessions map will have it under that key once processing starts.
      if (task.status === 'processing') {
        await abortClaudeSession(taskId);
      }

      const cancelled = proofreadTasksDb.cancelTask(taskId);
      if (!cancelled) return undefined; // already terminal

      const cancelledTask = proofreadTasksDb.getTask(taskId);
      if (cancelledTask) {
        await this.deliverTaskCallback(taskId);
      }

      return cancelledTask;
    },

    /**
     * Lists active (pending/processing) tasks for a user, most recent first.
     */
    listActiveTasks(userId: number) {
      return proofreadTasksDb.listByUser(userId, {
        statuses: ['pending', 'processing'],
        limit: 50,
      });
    },

    getSessionUrl,
  };
}

export type ProofreadService = ReturnType<typeof createProofreadService>;