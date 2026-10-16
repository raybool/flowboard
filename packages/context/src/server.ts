import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { GitContextIndexer, resolveGitRoot } from './indexer.js';
import {
  type AuditErrorCode,
  type AuditToolName,
  ContextStore,
  type ContextRecord,
  type ContextRecordKind,
  type FreshnessState,
  type TaskContext,
  type TaskContextPatch,
  TASK_CONTEXT_LIMITS,
} from './store.js';

const BYTES_PER_CONSERVATIVE_TOKEN = 3;
const MAX_SEARCH_LIMIT = 50;
const MAX_READ_LIMIT = 10;
const MAX_RETRIEVAL_TOKEN_BUDGET = 16_000;

export interface ContextLimits {
  searchLimit: number;
  readLimit: number;
  retrievalTokenBudget: number;
}

const DEFAULT_CONTEXT_LIMITS: ContextLimits = {
  searchLimit: 5,
  readLimit: 3,
  retrievalTokenBudget: 2_000,
};

function configuredInteger(
  value: number | undefined,
  environmentName: string,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? Number.parseInt(process.env[environmentName] ?? '', 10);
  return Number.isInteger(candidate) && candidate >= 1
    ? Math.min(candidate, maximum)
    : fallback;
}

export function resolveContextLimits(
  overrides: Partial<ContextLimits> = {},
): ContextLimits {
  return {
    searchLimit: configuredInteger(
      overrides.searchLimit,
      'FLOWBOARD_CONTEXT_SEARCH_LIMIT',
      DEFAULT_CONTEXT_LIMITS.searchLimit,
      MAX_SEARCH_LIMIT,
    ),
    readLimit: configuredInteger(
      overrides.readLimit,
      'FLOWBOARD_CONTEXT_READ_LIMIT',
      DEFAULT_CONTEXT_LIMITS.readLimit,
      MAX_READ_LIMIT,
    ),
    retrievalTokenBudget: configuredInteger(
      overrides.retrievalTokenBudget,
      'FLOWBOARD_CONTEXT_RETRIEVAL_TOKEN_BUDGET',
      DEFAULT_CONTEXT_LIMITS.retrievalTokenBudget,
      MAX_RETRIEVAL_TOKEN_BUDGET,
    ),
  };
}

function resolveRoot(): string {
  return path.resolve(process.env.FLOWBOARD_CONTEXT_ROOT ?? process.cwd());
}

function resolveDatabasePath(root: string): string {
  return process.env.FLOWBOARD_CONTEXT_DB
    ? path.resolve(process.env.FLOWBOARD_CONTEXT_DB)
    : path.join(root, '.flowboard-context', 'context.sqlite');
}

function result(value: unknown) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<
    string,
    unknown
  >;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

interface LimitedRecords {
  records: ContextRecord[];
  returnedCount: number;
  totalCount: number;
  omittedCount: number;
  truncated: boolean;
  hasMore: boolean;
  truncationReason: 'result_limit' | 'response_budget' | 'result_limit_and_response_budget' | null;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
}

function estimatedTokens(value: unknown): number {
  // This is deliberately conservative and is not an exact tokenizer result.
  return Math.ceil(serializedBytes(value) / BYTES_PER_CONSERVATIVE_TOKEN);
}

function shorten(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function compactRecord(record: ContextRecord): ContextRecord {
  return {
    ...record,
    title: shorten(record.title, 120),
    summary: shorten(record.summary, 240),
    symbols: record.symbols.slice(0, 8).map((symbol) => shorten(symbol, 80)),
    imports: record.imports.slice(0, 8).map((item) => shorten(item, 80)),
  };
}

function compactTaskContext(taskContext: TaskContext): TaskContext {
  return {
    ...taskContext,
    objective: shorten(taskContext.objective, 300),
    affectedFiles: taskContext.affectedFiles.slice(0, 4).map((item) => shorten(item, 100)),
    architectureDecisions: taskContext.architectureDecisions
      .slice(0, 4)
      .map((item) => shorten(item, 120)),
    constraints: taskContext.constraints.slice(0, 4).map((item) => shorten(item, 120)),
    completedWork: taskContext.completedWork.slice(0, 4).map((item) => shorten(item, 120)),
    verificationResults: taskContext.verificationResults
      .slice(0, 4)
      .map((item) => shorten(item, 120)),
    openIssues: taskContext.openIssues.slice(0, 4).map((item) => shorten(item, 120)),
    sourceReferences: taskContext.sourceReferences.slice(0, 4).map((item) => shorten(item, 120)),
  };
}

function taskContextView(taskContext: TaskContext): Record<string, unknown> {
  return {
    task_id: taskContext.taskId,
    objective: taskContext.objective,
    affected_files: taskContext.affectedFiles,
    architecture_decisions: taskContext.architectureDecisions,
    constraints: taskContext.constraints,
    completed_work: taskContext.completedWork,
    verification_results: taskContext.verificationResults,
    open_issues: taskContext.openIssues,
    source_references: taskContext.sourceReferences,
    created_at: taskContext.createdAt,
    updated_at: taskContext.updatedAt,
    revision: taskContext.revision,
  };
}

function taskContextPayload(
  taskContext: TaskContext,
  tokenBudget: number,
): Record<string, unknown> {
  const full = { taskContext: taskContextView(taskContext), taskContextTruncated: false };
  if (estimatedTokens(full) <= tokenBudget) {
    return full;
  }
  const compact = {
    taskContext: taskContextView(compactTaskContext(taskContext)),
    taskContextTruncated: true,
  };
  if (estimatedTokens(compact) <= tokenBudget) {
    return compact;
  }
  return {
    taskContext: taskContextView({
      ...taskContext,
      objective: shorten(taskContext.objective, 160),
      affectedFiles: [],
      architectureDecisions: [],
      constraints: [],
      completedWork: [],
      verificationResults: [],
      openIssues: [],
      sourceReferences: [],
    }),
    taskContextTruncated: true,
  };
}

function boundedBase(
  base: Record<string, unknown>,
  tokenBudget: number,
): Record<string, unknown> {
  const metadata = {
    records: [],
    returnedCount: 0,
    totalCount: 0,
    omittedCount: 0,
    truncated: false,
    hasMore: false,
    truncationReason: null,
  };
  if (estimatedTokens({ ...base, ...metadata }) <= tokenBudget) {
    return base;
  }
  const freshness = base.freshness;
  if (!freshness || typeof freshness !== 'object' || Array.isArray(freshness)) {
    return base;
  }
  const freshnessRecord = freshness as Record<string, unknown>;
  return {
    ...base,
    freshness: {
      ...freshnessRecord,
      staleIds: Array.isArray(freshnessRecord.staleIds)
        ? freshnessRecord.staleIds.slice(0, 3)
        : [],
      staleIdsTruncated: true,
      unknownIds: Array.isArray(freshnessRecord.unknownIds)
        ? freshnessRecord.unknownIds.slice(0, 3)
        : [],
      unknownIdsTruncated: true,
    },
  };
}

function freshnessFor(
  record: ContextRecord,
  staleIds: ReadonlySet<string>,
  unknownIds: ReadonlySet<string>,
): ContextRecord {
  const freshness: FreshnessState = staleIds.has(record.id)
    ? 'stale'
    : unknownIds.has(record.id)
      ? 'unknown'
      : 'fresh';
  return { ...record, stale: freshness === 'stale', freshness };
}

function combineFreshness(
  ...values: Array<{
    commit: string;
    checked: number;
    fresh: number;
    stale: number;
    unknown: number;
    changed: number;
    staleIds: string[];
    unknownIds: string[];
  }>
) {
  return {
    commit: values.find((value) => value.commit !== 'unknown')?.commit ?? 'unknown',
    checked: values.reduce((total, value) => total + value.checked, 0),
    fresh: values.reduce((total, value) => total + value.fresh, 0),
    stale: values.reduce((total, value) => total + value.stale, 0),
    unknown: values.reduce((total, value) => total + value.unknown, 0),
    changed: values.reduce((total, value) => total + value.changed, 0),
    staleIds: values.flatMap((value) => value.staleIds),
    unknownIds: values.flatMap((value) => value.unknownIds),
  };
}

function limitedRecords(
  base: Record<string, unknown>,
  records: ContextRecord[],
  maximumRecords: number,
  tokenBudget: number,
  hasMore: boolean,
): Record<string, unknown> & LimitedRecords {
  const bounded = boundedBase(base, tokenBudget);
  const candidates = records.slice(0, maximumRecords);
  const resultRecords: ContextRecord[] = [];
  const baseTruncated = base.taskContextTruncated === true;
  let responseBudgetExceeded = false;
  for (const record of candidates) {
    const nextRecords = [...resultRecords, record];
    const candidate = {
      ...bounded,
      records: nextRecords,
      returnedCount: nextRecords.length,
      totalCount: records.length,
      omittedCount: Math.max(records.length - nextRecords.length, 0),
      truncated: false,
      hasMore,
      truncationReason: null,
    };
    if (estimatedTokens(candidate) <= tokenBudget) {
      resultRecords.push(record);
      continue;
    }
    responseBudgetExceeded = true;
    if (resultRecords.length === 0) {
      const compact = compactRecord(record);
      const compactCandidate = {
        ...candidate,
        records: [compact],
        returnedCount: 1,
        omittedCount: Math.max(records.length - 1, 0),
      };
      if (estimatedTokens(compactCandidate) <= tokenBudget) {
        resultRecords.push(compact);
      }
    }
    break;
  }
  const omittedCount = Math.max(records.length - resultRecords.length, 0);
  const resultLimitExceeded = omittedCount > 0 || hasMore;
  const truncated = baseTruncated || resultLimitExceeded || responseBudgetExceeded;
  let truncationReason: LimitedRecords['truncationReason'] = null;
  if (truncated) {
    truncationReason = responseBudgetExceeded || baseTruncated
      ? resultLimitExceeded
        ? 'result_limit_and_response_budget'
        : 'response_budget'
      : 'result_limit';
  }
  let payload: Record<string, unknown> & LimitedRecords = {
    ...bounded,
    records: resultRecords,
    returnedCount: resultRecords.length,
    totalCount: records.length,
    omittedCount,
    truncated,
    hasMore,
    truncationReason,
  };
  while (estimatedTokens(payload) > tokenBudget && resultRecords.length > 0) {
    resultRecords.pop();
    responseBudgetExceeded = true;
    const omitted = Math.max(records.length - resultRecords.length, 0);
    const resultLimited = omitted > 0 || hasMore;
    const reason: LimitedRecords['truncationReason'] = resultLimited
      ? 'result_limit_and_response_budget'
      : 'response_budget';
    payload = {
      ...bounded,
      records: resultRecords,
      returnedCount: resultRecords.length,
      totalCount: records.length,
      omittedCount: omitted,
      truncated: true,
      hasMore,
      truncationReason: reason,
    };
  }
  return payload;
}

function recordResult(record: ContextRecord) {
  return result({ record });
}

interface AuditedOperationResult<T> {
  response: T;
  resultCount: number;
  revisionAfter?: number | null;
}

function responseBytes(response: unknown): number {
  if (!response || typeof response !== 'object') {
    return 0;
  }
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((total, block) => {
    if (!block || typeof block !== 'object') {
      return total;
    }
    const text = (block as { text?: unknown }).text;
    return typeof text === 'string'
      ? total + Buffer.byteLength(text, 'utf8')
      : total;
  }, 0);
}

function auditErrorCode(error: unknown): AuditErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/revision conflict/iu.test(message)) return 'revision_conflict';
  if (/secret|personal data/iu.test(message)) return 'sensitive_data';
  if (/path|traversal|repository root|control/iu.test(message)) return 'unsafe_path';
  if (/too large|at most|maximum/iu.test(message)) return 'size_limit';
  if (/not found/iu.test(message)) return 'not_found';
  if (/must|required|unsupported|concise|empty/iu.test(message)) return 'invalid_input';
  return 'operation_failed';
}

function auditToolCall<T>(
  store: ContextStore,
  tool: AuditToolName,
  context: {
    taskId?: string;
    agentRole?: string;
    mode?: string;
    stage?: string;
    agentEvent?: string;
    escalationReason?: string;
    requestBytes?: number;
    revisionBefore?: number | null;
    retryCount?: number;
  },
  operation: () => AuditedOperationResult<T>,
): T {
  const startedAt = new Date().toISOString();
  const started = process.hrtime.bigint();
  const duration = () => Number(process.hrtime.bigint() - started) / 1_000_000;
  const writeAudit = (input: {
    resultCount: number;
    responseBytes: number;
    success: boolean;
    revisionAfter?: number | null;
    errorCode?: AuditErrorCode | null;
  }) => {
    // A logging failure must not turn a successful MCP read into a tool failure.
    try {
      store.recordAudit({
        occurredAt: startedAt,
        tool,
        taskId: context.taskId,
        agentRole: context.agentRole,
        mode: context.mode,
        stage: context.stage,
        agentEvent: context.agentEvent,
        escalationReason: context.escalationReason,
        requestBytes: context.requestBytes ?? 0,
        durationMs: duration(),
        revisionBefore: context.revisionBefore,
        retryCount: context.retryCount,
        revisionAfter: input.revisionAfter,
        errorCode: input.errorCode,
        ...input,
      });
    } catch {
      // The primary context operation remains authoritative.
    }
  };

  try {
    const operationResult = operation();
    writeAudit({
      resultCount: operationResult.resultCount,
      responseBytes: responseBytes(operationResult.response),
      success: true,
      revisionAfter: operationResult.revisionAfter,
    });
    return operationResult.response;
  } catch (error) {
    writeAudit({
      resultCount: 0,
      responseBytes: 0,
      success: false,
      errorCode: auditErrorCode(error),
    });
    throw error;
  }
}

const manualKind = z.enum([
  'architecture', 'api_contract', 'module', 'fact', 'decision', 'task', 'assumption',
]);
const allKind = z.enum([
  'source', 'architecture', 'api_contract', 'module', 'fact', 'decision', 'task', 'assumption',
]);

export function createContextServer(options: {
  root?: string;
  databasePath?: string;
  limits?: Partial<ContextLimits>;
} = {}) {
  const root = resolveGitRoot(path.resolve(options.root ?? resolveRoot()));
  const limits = resolveContextLimits(options.limits);
  const store = new ContextStore(
    options.databasePath ?? resolveDatabasePath(root),
  );
  const indexer = new GitContextIndexer(store, root);
  const server = new McpServer({ name: 'flowboard-context', version: '0.1.0' });

  server.registerTool(
    'context.search',
    {
      description: 'Search concise project context. Confirmed records are returned by default.',
      inputSchema: z.object({
        query: z.string().min(1).max(256).refine((value) => value.trim().length > 0),
        limit: z.number().int().min(1).max(50).optional(),
        includeProposed: z.boolean().optional(),
        kind: allKind.optional(),
        task_id: z.string().min(1).max(160).optional(),
        agent_role: z.string().min(1).max(80).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, limit, includeProposed, kind, task_id, agent_role }) =>
      auditToolCall(
        store,
        'context.search',
        {
          taskId: task_id,
          agentRole: agent_role,
          requestBytes: serializedBytes({ query, limit, includeProposed, kind, task_id, agent_role }),
        },
        () => {
        const searchOptions = {
          limit: Math.min(limit ?? limits.searchLimit, limits.searchLimit),
          includeProposed,
          kind: kind as ContextRecordKind | undefined,
        };
        const candidates = store.search(query, {
          ...searchOptions,
          limit: MAX_SEARCH_LIMIT,
          includeStale: true,
        });
        const freshness = indexer.refreshStaleness(candidates, false);
        const staleIds = new Set(freshness.staleIds);
        const unknownIds = new Set(freshness.unknownIds);
        const records = candidates
          .filter((record) => !staleIds.has(record.id))
          .map((record) => freshnessFor(record, staleIds, unknownIds));
        const limited = limitedRecords(
          { freshness },
          records,
          searchOptions.limit,
          limits.retrievalTokenBudget,
          candidates.length === MAX_SEARCH_LIMIT,
        );
        return {
          response: result(limited),
          resultCount: limited.returnedCount,
        };
        },
      ),
  );

  server.registerTool(
    'context.get',
    {
      description: 'Get one context record by stable ID, including source and status.',
      inputSchema: z.object({
        id: z.string().uuid().optional(),
        ids: z.array(z.string().uuid()).min(1).max(20).optional(),
        task_id: z.string().min(1).max(160).optional(),
        agent_role: z.string().min(1).max(80).optional(),
      }).refine(
        ({ id, ids }) => (id === undefined) !== (ids === undefined),
        { message: 'Provide exactly one id or a non-empty ids array.' },
      ),
      annotations: { readOnlyHint: true },
    },
    ({ id, ids, task_id, agent_role }) =>
      auditToolCall(
        store,
        'context.get',
        {
          taskId: task_id,
          agentRole: agent_role,
          requestBytes: serializedBytes({ id, ids, task_id, agent_role }),
        },
        () => {
        const requestedIds = [...new Set(ids ?? (id === undefined ? [] : [id]))];
        const records = requestedIds.map((requestedId) => {
          const record = store.get(requestedId);
          if (!record) {
            throw new Error(`Context record ${requestedId} was not found.`);
          }
          return record;
        });
        const freshness = indexer.refreshStaleness(records, false);
        const staleIds = new Set(freshness.staleIds);
        const unknownIds = new Set(freshness.unknownIds);
        const freshRecords = records.map((record) => freshnessFor(record, staleIds, unknownIds));
        const limited = limitedRecords(
          { freshness },
          freshRecords,
          limits.readLimit,
          limits.retrievalTokenBudget,
          false,
        );
        if (id !== undefined) {
          const record = limited.records[0];
          if (!record) {
            throw new Error('The requested context record exceeds the configured response budget.');
          }
          return {
            response: result({
              freshness,
              record,
              returnedCount: limited.returnedCount,
              totalCount: limited.totalCount,
              omittedCount: limited.omittedCount,
              truncated: limited.truncated,
              hasMore: limited.hasMore,
              truncationReason: limited.truncationReason,
            }),
            resultCount: 1,
          };
        }
        return {
          response: result(limited),
          resultCount: limited.returnedCount,
        };
        },
      ),
  );

  server.registerTool(
    'context.save',
    {
      description:
        'Save a concise proposed architecture, API contract, module, fact, decision, task, or assumption. CLI confirmation is required.',
      inputSchema: z.object({
        title: z.string().min(1).max(160),
        summary: z.string().min(1).max(1200),
        sourcePath: z.string().min(1).max(500),
        kind: manualKind.optional(),
        key: z.string().max(128).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ title, summary, sourcePath, kind, key }) =>
      recordResult(
        store.createProposal({
          title,
          summary,
          source: indexer.snapshotSource(sourcePath),
          kind: kind ?? 'fact',
          key,
        }),
      ),
  );

  server.registerTool(
    'context.update',
    {
      description:
        'Create a proposed replacement for a manual record. The existing record is unchanged until CLI confirmation.',
      inputSchema: z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(160).optional(),
        summary: z.string().min(1).max(1200).optional(),
        sourcePath: z.string().min(1).max(500).optional(),
        kind: manualKind.optional(),
        key: z.string().max(128).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ id, title, summary, sourcePath, kind, key }) => {
      if (
        title === undefined &&
        summary === undefined &&
        sourcePath === undefined &&
        kind === undefined &&
        key === undefined
      ) {
        throw new Error('At least one update field is required.');
      }
      const existing = store.get(id);
      if (!existing) {
        throw new Error(`Context record ${id} was not found.`);
      }
      return recordResult(
        store.proposeUpdate(id, {
          source: indexer.snapshotSource(sourcePath ?? existing.source.path),
          title,
          summary,
          kind,
          key,
        }),
      );
    },
  );

  server.registerTool(
    'context.get_task',
    {
      description:
        'Use context.search for ordinary knowledge retrieval. Read the current task handoff here only when a task ID and its previous state are needed.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(160).optional(),
        includeProposed: z.boolean().optional(),
        task_id: z.string().min(1).max(160).optional(),
        agent_role: z.string().min(1).max(80).optional(),
      }).refine(
        ({ taskId, task_id }) => taskId !== undefined || task_id !== undefined,
        { message: 'Provide taskId or task_id.' },
      ),
      annotations: { readOnlyHint: true },
    },
    ({ taskId, includeProposed, task_id, agent_role }) =>
      auditToolCall(
        store,
        'context.get_task',
        {
          taskId: task_id ?? taskId,
          agentRole: agent_role,
          requestBytes: serializedBytes({ taskId, includeProposed, task_id, agent_role }),
        },
        () => {
          const lookupTaskId = taskId ?? task_id;
          if (lookupTaskId === undefined) {
            throw new Error('Provide taskId or task_id.');
          }
          const candidates = store.getTask(lookupTaskId, includeProposed, true, MAX_SEARCH_LIMIT);
          const recordFreshness = indexer.refreshStaleness(candidates, false);
          const taskContext = store.getTaskContext(lookupTaskId);
          const sourceReferencesFreshness = taskContext
            ? indexer.refreshStalenessForPaths(taskContext.sourceReferences)
            : {
                commit: recordFreshness.commit,
                checked: 0,
                fresh: 0,
                stale: 0,
                unknown: 0,
                changed: 0,
                staleIds: [],
                unknownIds: [],
              };
          const freshness = combineFreshness(recordFreshness, sourceReferencesFreshness);
          const staleIds = new Set(recordFreshness.staleIds);
          const unknownIds = new Set(recordFreshness.unknownIds);
          const records = candidates
            .filter((record) => !staleIds.has(record.id))
            .map((record) => freshnessFor(record, staleIds, unknownIds));
          const taskContextData = taskContext
            ? taskContextPayload(taskContext, limits.retrievalTokenBudget)
            : { taskContext: null, taskContextTruncated: false };
          const limited = limitedRecords(
            {
              freshness,
              source_references_freshness: sourceReferencesFreshness,
              ...taskContextData,
            },
            records,
            limits.readLimit,
            limits.retrievalTokenBudget,
            candidates.length === MAX_SEARCH_LIMIT,
          );
          return {
            response: result(limited),
            resultCount: limited.returnedCount,
          };
        },
      ),
  );

  server.registerTool(
    'context.update_task_context',
    {
      description:
        'Create or update the current task handoff only after a substantial change or before handing the task to another agent. Omitted fields stay unchanged; arrays replace their previous field. Repeating an identical handoff is a no-op.',
      inputSchema: z.object({
        task_id: z.string().min(1).max(TASK_CONTEXT_LIMITS.taskId),
        agent_role: z.string().min(1).max(80).optional(),
        expected_revision: z.number().int().min(0).optional(),
        objective: z.string().min(1).optional(),
        affected_files: z.array(z.string().min(1)).optional(),
        architecture_decisions: z.array(z.string().min(1)).optional(),
        constraints: z.array(z.string().min(1)).optional(),
        completed_work: z.array(z.string().min(1)).optional(),
        verification_results: z.array(z.string().min(1)).optional(),
        open_issues: z.array(z.string().min(1)).optional(),
        source_references: z.array(z.string().min(1)).optional(),
        retry_count: z.number().int().min(0).max(100).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({
      task_id,
      agent_role,
      expected_revision,
      objective,
      affected_files,
      architecture_decisions,
      constraints,
      completed_work,
      verification_results,
      open_issues,
      source_references,
      retry_count,
    }) => {
      const revisionBefore = store.getTaskContext(task_id)?.revision ?? 0;
      const requestBytes = serializedBytes({
        task_id,
        agent_role,
        expected_revision,
        objective,
        affected_files,
        architecture_decisions,
        constraints,
        completed_work,
        verification_results,
        open_issues,
        source_references,
        retry_count,
      });
      return auditToolCall(
        store,
        'context.update_task_context',
        {
          taskId: task_id,
          agentRole: agent_role,
          requestBytes,
          revisionBefore,
          retryCount: retry_count,
        },
        () => {
          const taskContext = store.updateTaskContext({
            taskId: task_id,
            expectedRevision: expected_revision,
            objective,
            affectedFiles: affected_files,
            architectureDecisions: architecture_decisions,
            constraints,
            completedWork: completed_work,
            verificationResults: verification_results,
            openIssues: open_issues,
            sourceReferences: source_references,
          } satisfies TaskContextPatch);
          return {
            response: result(taskContextPayload(taskContext, limits.retrievalTokenBudget)),
            resultCount: 1,
            revisionAfter: taskContext.revision,
          };
        },
      );
    },
  );

  server.registerTool(
    'context.invalidate',
    {
      description: 'Hide an obsolete context record without deleting its history.',
      inputSchema: z.object({
        id: z.string().uuid(),
        reason: z.string().min(1).max(240).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    ({ id, reason }) =>
      recordResult(
        store.invalidate(id, reason ?? 'Invalidated through context.invalidate'),
      ),
  );

  return { server, store, indexer };
}

export async function runContextServer(): Promise<void> {
  const { server, store } = createContextServer();
  const close = async () => {
    await server.close();
    store.close();
  };
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  await server.connect(new StdioServerTransport());
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runContextServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
