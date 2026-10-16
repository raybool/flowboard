import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type ContextRecordStatus = 'confirmed' | 'proposed' | 'invalidated';
export type ContextRecordKind =
  | 'source'
  | 'architecture'
  | 'api_contract'
  | 'module'
  | 'fact'
  | 'decision'
  | 'task'
  | 'assumption';
export type ContextSourceKind = 'git' | 'manual';

export interface SourceSnapshot {
  path: string;
  commit: string;
  hash: string;
  modifiedAt: string;
}

export interface ContextRecord {
  id: string;
  key: string | null;
  kind: ContextRecordKind;
  title: string;
  summary: string;
  symbols: string[];
  imports: string[];
  sourceKind: ContextSourceKind;
  source: SourceSnapshot;
  status: ContextRecordStatus;
  stale: boolean;
  supersedesId: string | null;
  invalidationReason: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  invalidatedAt: string | null;
  rank?: number;
}

export interface IndexedSourceInput {
  kind: 'source' | 'architecture' | 'api_contract' | 'module';
  title: string;
  summary: string;
  symbols: string[];
  imports: string[];
  source: SourceSnapshot;
}

export interface ProposalInput {
  key?: string;
  kind: Exclude<ContextRecordKind, 'source'>;
  title: string;
  summary: string;
  source: SourceSnapshot;
}

export interface ProposalPatch {
  key?: string;
  kind?: Exclude<ContextRecordKind, 'source'>;
  title?: string;
  summary?: string;
  source: SourceSnapshot;
}

export interface SearchOptions {
  limit?: number;
  includeProposed?: boolean;
  kind?: ContextRecordKind;
  includeStale?: boolean;
}

export interface StoreStatus {
  databasePath: string;
  journalMode: string;
  counts: Record<ContextRecordStatus, number>;
  stale: number;
  indexedSources: number;
  lastIndexedAt: string | null;
  lastIndexedCommit: string | null;
}

export type AuditToolName =
  | 'context.search'
  | 'context.get'
  | 'context.get_task'
  | 'context.update_task_context';

export interface AuditLogInput {
  occurredAt: string;
  tool: AuditToolName;
  taskId?: string;
  agentRole?: string;
  requestBytes: number;
  durationMs: number;
  resultCount: number;
  responseBytes: number;
  success: boolean;
  revisionBefore?: number | null;
  revisionAfter?: number | null;
}

export interface AuditToolStats {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  resultCount: number;
  requestBytes: number;
  responseBytes: number;
  averageDurationMs: number;
  latestAt: string | null;
}

export interface AuditStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  resultCount: number;
  requestBytes: number;
  responseBytes: number;
  averageDurationMs: number;
  latestAt: string | null;
  byTool: Record<AuditToolName, AuditToolStats>;
}

export interface AuditStatsOptions {
  tool?: AuditToolName;
  taskId?: string;
  agentRole?: string;
  since?: string;
  until?: string;
}

export interface TaskContext {
  taskId: string;
  objective: string;
  affectedFiles: string[];
  architectureDecisions: string[];
  constraints: string[];
  completedWork: string[];
  verificationResults: string[];
  openIssues: string[];
  sourceReferences: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface TaskContextPatch {
  taskId: string;
  expectedRevision?: number;
  objective?: string;
  affectedFiles?: string[];
  architectureDecisions?: string[];
  constraints?: string[];
  completedWork?: string[];
  verificationResults?: string[];
  openIssues?: string[];
  sourceReferences?: string[];
}

export const TASK_CONTEXT_LIMITS = {
  taskId: 160,
  pathItem: 240,
  contentItem: 1200,
  objective: 1600,
  maxItems: 16,
  maxBytes: 12_000,
} as const;

export interface StoredSourceReference {
  id: string;
  path: string;
  commit: string;
  hash: string;
}

interface RecordRow {
  id: string;
  record_key: string | null;
  kind: ContextRecordKind;
  title: string;
  summary: string;
  symbols_json: string;
  imports_json: string;
  source_kind: ContextSourceKind;
  source_path: string;
  source_commit: string;
  source_hash: string;
  source_modified_at: string;
  status: ContextRecordStatus;
  stale: number;
  supersedes_id: string | null;
  invalidation_reason: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  invalidated_at: string | null;
  rank?: number;
}

interface TaskContextRow {
  task_id: string;
  objective: string;
  affected_files_json: string;
  architecture_decisions_json: string;
  constraints_json: string;
  completed_work_json: string;
  verification_results_json: string;
  open_issues_json: string;
  source_references_json: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:[A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)|authorization)\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|`[^`\r\n]{8,}`|[A-Za-z0-9+/=_-]{8,}(?![A-Za-z0-9_./-]))/i;

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bghp_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bASIA[0-9A-Z]{16}\b/u,
  /\b(?:sk|rk|xox[baprs])-[A-Za-z0-9_-]{16,}\b/u,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/@:]+:[^\s/@]+@/iu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  SENSITIVE_ASSIGNMENT_PATTERN,
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/u,
];
const SENSITIVE_METADATA_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:api[_-]?key|credentials?|jwt[_-]?secret|password|passwd|private[_-]?key|secrets?|tokens?)(?:$|[^A-Za-z0-9])/iu;
const SENSITIVE_PATH_PATTERN =
  /(?:^|[/._-])(?:api[_-]?keys?|credentials?|jwt[_-]?secrets?|private[_-]?keys?|secrets?)(?:[/._-]|$)/iu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE_PATTERN = /(?:^|\D)(?:\+?\d[\s().-]*){8,}(?:$|\D)/;
const TASK_CONTEXT_MAX_ITEMS = TASK_CONTEXT_LIMITS.maxItems;
const TASK_CONTEXT_ITEM_MAX_LENGTH = TASK_CONTEXT_LIMITS.contentItem;
const TASK_CONTEXT_MAX_BYTES = TASK_CONTEXT_LIMITS.maxBytes;

export function containsSensitiveText(value: string): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => pattern.test(value)) ||
    EMAIL_PATTERN.test(value) ||
    PHONE_PATTERN.test(value)
  );
}

export function containsSensitiveMetadata(value: string): boolean {
  return containsSensitiveText(value) || SENSITIVE_METADATA_PATTERN.test(value);
}

export function containsSensitivePathMetadata(value: string): boolean {
  return containsSensitiveText(value) || SENSITIVE_PATH_PATTERN.test(value);
}

export function sanitizeAuditContext(
  value: string | undefined,
  maxLength: number,
): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /\r?\n/u.test(normalized) ||
    containsSensitiveMetadata(normalized)
  ) {
    return null;
  }
  return normalized;
}

function assertSafeText(
  value: string,
  field: string,
  maxLength: number,
  maxLines: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  if (normalized.split(/\r?\n/u).length > maxLines) {
    throw new Error(`${field} must be a concise summary, not source text.`);
  }
  if (containsSensitiveMetadata(normalized)) {
    throw new Error(`${field} may contain a secret or personal data.`);
  }
  return normalized;
}

function assertRecordKey(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') {
    return null;
  }
  const normalized = value.trim();
  if (containsSensitiveMetadata(normalized)) {
    throw new Error('key may contain a secret or personal data.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(normalized)) {
    throw new Error('key contains unsupported characters.');
  }
  return normalized;
}

function assertSafeMetadataItems(
  values: string[],
  field: string,
  sensitiveCheck: (value: string) => boolean = containsSensitiveMetadata,
): string[] {
  return values.map((value) => {
    const normalized = value.trim();
    if (
      normalized.length === 0 ||
      normalized.length > 160 ||
      sensitiveCheck(normalized)
    ) {
      throw new Error(`${field} contains sensitive or unsupported metadata.`);
    }
    return normalized;
  });
}

function stableMetadataItems(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assertTaskContextText(
  value: string,
  field: string,
  maxLength: number,
  sensitiveCheck: (value: string) => boolean = containsSensitiveText,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters.`);
  }
  if (/\r?\n/u.test(normalized)) {
    throw new Error(`${field} must be a concise one-line value.`);
  }
  if (sensitiveCheck(normalized)) {
    throw new Error(`${field} may contain a secret or personal data.`);
  }
  return normalized;
}

function assertTaskContextItems(
  values: string[],
  field: string,
  sensitiveCheck: (value: string) => boolean = containsSensitiveText,
  maxLength: number = TASK_CONTEXT_ITEM_MAX_LENGTH,
): string[] {
  if (values.length > TASK_CONTEXT_MAX_ITEMS) {
    throw new Error(`${field} may contain at most ${TASK_CONTEXT_MAX_ITEMS} items.`);
  }
  const normalized = values.map((value) =>
    assertTaskContextText(value, field, maxLength, sensitiveCheck),
  );
  return [...new Set(normalized)];
}

const RECORD_KIND_SQL =
  "'source', 'architecture', 'api_contract', 'module', 'fact', 'decision', 'task', 'assumption'";

function now(): string {
  return new Date().toISOString();
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
    ? parsed
    : [];
}

function rowToRecord(row: RecordRow): ContextRecord {
  return {
    id: row.id,
    key: row.record_key,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    symbols: parseStringArray(row.symbols_json),
    imports: parseStringArray(row.imports_json),
    sourceKind: row.source_kind,
    source: {
      path: row.source_path,
      commit: row.source_commit,
      hash: row.source_hash,
      modifiedAt: row.source_modified_at,
    },
    status: row.status,
    stale: row.stale === 1,
    supersedesId: row.supersedes_id,
    invalidationReason: row.invalidation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    invalidatedAt: row.invalidated_at,
    ...(row.rank === undefined ? {} : { rank: row.rank }),
  };
}

function rowToTaskContext(row: TaskContextRow): TaskContext {
  return {
    taskId: row.task_id,
    objective: row.objective,
    affectedFiles: parseStringArray(row.affected_files_json),
    architectureDecisions: parseStringArray(row.architecture_decisions_json),
    constraints: parseStringArray(row.constraints_json),
    completedWork: parseStringArray(row.completed_work_json),
    verificationResults: parseStringArray(row.verification_results_json),
    openIssues: parseStringArray(row.open_issues_json),
    sourceReferences: parseStringArray(row.source_references_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

function searchTerms(value: string): string[] {
  const terms = value
    .slice(0, 256)
    .match(/[\p{L}\p{N}_@./:-]+/gu)
    ?.slice(0, 12) ?? [];
  return terms.map((term) => term.toLowerCase());
}

function ftsQuery(value: string, operator = ' AND '): string | null {
  const terms = searchTerms(value);
  if (terms.length === 0) {
    return null;
  }
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(operator);
}

function fieldTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function hasSearchTerm(value: string, term: string): boolean {
  return fieldTokens(value).some((token) => token === term || token.startsWith(term));
}

interface SearchCandidate {
  record: ContextRecord;
  ftsRank: number;
}

function rankSearchCandidate(
  candidate: SearchCandidate,
  query: string,
  terms: string[],
  fallback: boolean,
): [number, number, number, number, string, string] {
  const path = candidate.record.source.path.toLowerCase();
  const basename = path.split('/').at(-1) ?? path;
  const normalizedQuery = query.trim().toLowerCase();
  const pathExact =
    path === normalizedQuery || basename === normalizedQuery
      ? 1
      : terms.filter((term) => fieldTokens(path).includes(term)).length;
  const symbolExact = candidate.record.symbols.filter((symbol) => {
    const normalized = symbol.toLowerCase();
    return normalized === normalizedQuery || terms.some((term) => normalized === term);
  }).length;
  const matchedTerms = terms.filter((term) =>
    [
      candidate.record.title,
      candidate.record.summary,
      candidate.record.source.path,
      ...candidate.record.symbols,
      ...candidate.record.imports,
    ].some((field) => hasSearchTerm(field, term)),
  ).length;

  // Strict results all cover the query, so exact path/symbol matches lead.
  // Fallback results first prefer documents covering more query terms.
  return fallback
    ? [matchedTerms, pathExact, symbolExact, -candidate.ftsRank, path, candidate.record.id]
    : [pathExact, symbolExact, matchedTerms, -candidate.ftsRank, path, candidate.record.id];
}

export class ContextStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ':memory:') {
      const directory = path.dirname(databasePath);
      const directoryExisted = existsSync(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!directoryExisted || path.basename(directory) === '.flowboard-context') {
        chmodSync(directory, 0o700);
      }
      closeSync(openSync(databasePath, 'a', 0o600));
      chmodSync(databasePath, 0o600);
    }
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    if (databasePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
    }
    this.migrate();
    if (databasePath !== ':memory:') {
      chmodSync(databasePath, 0o600);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_records (
        id TEXT PRIMARY KEY,
        record_key TEXT,
        kind TEXT NOT NULL CHECK (kind IN (${RECORD_KIND_SQL})),
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        symbols_json TEXT NOT NULL DEFAULT '[]',
        imports_json TEXT NOT NULL DEFAULT '[]',
        source_kind TEXT NOT NULL CHECK (source_kind IN ('git', 'manual')),
        source_path TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_modified_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('confirmed', 'proposed', 'invalidated')),
        stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
        supersedes_id TEXT REFERENCES context_records(id),
        invalidation_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmed_at TEXT,
        invalidated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS context_records_status_idx
        ON context_records(status, kind, updated_at DESC);
      CREATE INDEX IF NOT EXISTS context_records_source_idx
        ON context_records(source_kind, source_path);
      CREATE INDEX IF NOT EXISTS context_records_key_idx
        ON context_records(record_key, kind, status);

      CREATE TABLE IF NOT EXISTS context_index_state (
        source_path TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        source_commit TEXT NOT NULL,
        source_modified_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        record_id TEXT NOT NULL REFERENCES context_records(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS context_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS context_task_context (
        task_id TEXT PRIMARY KEY,
        objective TEXT NOT NULL,
        affected_files_json TEXT NOT NULL DEFAULT '[]',
        architecture_decisions_json TEXT NOT NULL DEFAULT '[]',
        constraints_json TEXT NOT NULL DEFAULT '[]',
        completed_work_json TEXT NOT NULL DEFAULT '[]',
        verification_results_json TEXT NOT NULL DEFAULT '[]',
        open_issues_json TEXT NOT NULL DEFAULT '[]',
        source_references_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1)
      );

      CREATE INDEX IF NOT EXISTS context_task_context_updated_idx
        ON context_task_context(updated_at DESC);

      CREATE TABLE IF NOT EXISTS context_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('context.search', 'context.get', 'context.get_task', 'context.update_task_context')),
        task_id TEXT,
        agent_role TEXT,
        request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        result_count INTEGER NOT NULL CHECK (result_count >= 0),
        response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        revision_before INTEGER,
        revision_after INTEGER
      );

      CREATE INDEX IF NOT EXISTS context_audit_log_occurred_idx
        ON context_audit_log(occurred_at DESC);
      CREATE INDEX IF NOT EXISTS context_audit_log_tool_idx
        ON context_audit_log(tool, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS context_audit_log_task_idx
        ON context_audit_log(task_id, occurred_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS context_records_fts USING fts5(
        title,
        summary,
        symbols,
        imports,
        source_path,
        content='context_records',
        content_rowid='rowid',
        tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS context_records_ai AFTER INSERT ON context_records BEGIN
        INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
        VALUES (new.rowid, new.title, new.summary, new.symbols_json, new.imports_json, new.source_path);
      END;

      CREATE TRIGGER IF NOT EXISTS context_records_ad AFTER DELETE ON context_records BEGIN
        INSERT INTO context_records_fts(context_records_fts, rowid, title, summary, symbols, imports, source_path)
        VALUES ('delete', old.rowid, old.title, old.summary, old.symbols_json, old.imports_json, old.source_path);
      END;

      CREATE TRIGGER IF NOT EXISTS context_records_au
        AFTER UPDATE OF title, summary, symbols_json, imports_json, source_path
        ON context_records BEGIN
        INSERT INTO context_records_fts(context_records_fts, rowid, title, summary, symbols, imports, source_path)
        VALUES ('delete', old.rowid, old.title, old.summary, old.symbols_json, old.imports_json, old.source_path);
        INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
        VALUES (new.rowid, new.title, new.summary, new.symbols_json, new.imports_json, new.source_path);
      END;
    `);
    this.migrateAuditLog();
    this.migrateRecordKinds();
    this.migrateFtsUpdateTrigger();
    this.db.exec('PRAGMA user_version = 2;');
  }

  private migrateFtsUpdateTrigger(): void {
    this.db.exec(`
      DROP TRIGGER IF EXISTS context_records_au;
      CREATE TRIGGER context_records_au
        AFTER UPDATE OF title, summary, symbols_json, imports_json, source_path
        ON context_records BEGIN
        INSERT INTO context_records_fts(context_records_fts, rowid, title, summary, symbols, imports, source_path)
        VALUES ('delete', old.rowid, old.title, old.summary, old.symbols_json, old.imports_json, old.source_path);
        INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
        VALUES (new.rowid, new.title, new.summary, new.symbols_json, new.imports_json, new.source_path);
      END;
    `);
  }

  private migrateAuditLog(): void {
    const schema = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_audit_log'",
      )
      .get() as { sql: string } | undefined;
    const columns = this.db
      .prepare('PRAGMA table_info(context_audit_log)')
      .all() as unknown as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    if (
      schema?.sql.includes('context.update_task_context') &&
      columnNames.has('request_bytes') &&
      columnNames.has('revision_before') &&
      columnNames.has('revision_after')
    ) {
      return;
    }

    this.db.exec(`
      DROP INDEX IF EXISTS context_audit_log_occurred_idx;
      DROP INDEX IF EXISTS context_audit_log_tool_idx;
      DROP INDEX IF EXISTS context_audit_log_task_idx;
      ALTER TABLE context_audit_log RENAME TO context_audit_log_legacy;
      CREATE TABLE context_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at TEXT NOT NULL,
        tool TEXT NOT NULL CHECK (tool IN ('context.search', 'context.get', 'context.get_task', 'context.update_task_context')),
        task_id TEXT,
        agent_role TEXT,
        request_bytes INTEGER NOT NULL CHECK (request_bytes >= 0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        result_count INTEGER NOT NULL CHECK (result_count >= 0),
        response_bytes INTEGER NOT NULL CHECK (response_bytes >= 0),
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        revision_before INTEGER,
        revision_after INTEGER
      );
      INSERT INTO context_audit_log (
        id, occurred_at, tool, task_id, agent_role, request_bytes,
        duration_ms, result_count, response_bytes, success, revision_before, revision_after
      )
      SELECT id, occurred_at, tool, task_id, agent_role, 0,
        duration_ms, result_count, response_bytes, success, NULL, NULL
      FROM context_audit_log_legacy;
      DROP TABLE context_audit_log_legacy;
      CREATE INDEX context_audit_log_occurred_idx
        ON context_audit_log(occurred_at DESC);
      CREATE INDEX context_audit_log_tool_idx
        ON context_audit_log(tool, occurred_at DESC);
      CREATE INDEX context_audit_log_task_idx
        ON context_audit_log(task_id, occurred_at DESC);
    `);
  }

  private migrateRecordKinds(): void {
    const schema = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'context_records'",
      )
      .get() as { sql: string } | undefined;
    if (!schema || schema.sql.includes("'architecture'")) {
      return;
    }

    this.db.exec('PRAGMA foreign_keys = OFF;');
    let committed = false;
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        DROP TRIGGER IF EXISTS context_records_ai;
        DROP TRIGGER IF EXISTS context_records_ad;
        DROP TRIGGER IF EXISTS context_records_au;
        DROP TABLE IF EXISTS context_records_fts;
        ALTER TABLE context_index_state RENAME TO context_index_state_legacy;
        ALTER TABLE context_records RENAME TO context_records_legacy;

        CREATE TABLE context_records (
          id TEXT PRIMARY KEY,
          record_key TEXT,
          kind TEXT NOT NULL CHECK (kind IN (${RECORD_KIND_SQL})),
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          symbols_json TEXT NOT NULL DEFAULT '[]',
          imports_json TEXT NOT NULL DEFAULT '[]',
          source_kind TEXT NOT NULL CHECK (source_kind IN ('git', 'manual')),
          source_path TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          source_modified_at TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('confirmed', 'proposed', 'invalidated')),
          stale INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0, 1)),
          supersedes_id TEXT REFERENCES context_records(id),
          invalidation_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          confirmed_at TEXT,
          invalidated_at TEXT
        );

        INSERT INTO context_records (
          id, record_key, kind, title, summary, symbols_json, imports_json,
          source_kind, source_path, source_commit, source_hash,
          source_modified_at, status, stale, supersedes_id,
          invalidation_reason, created_at, updated_at, confirmed_at, invalidated_at
        ) SELECT
          id, record_key, kind, title, summary, symbols_json, imports_json,
          source_kind, source_path, source_commit, source_hash,
          source_modified_at, status, stale, supersedes_id,
          invalidation_reason, created_at, updated_at, confirmed_at, invalidated_at
        FROM context_records_legacy;

        CREATE TABLE context_index_state (
          source_path TEXT PRIMARY KEY,
          source_hash TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          source_modified_at TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          record_id TEXT NOT NULL REFERENCES context_records(id) ON DELETE CASCADE
        );

        INSERT INTO context_index_state (
          source_path, source_hash, source_commit, source_modified_at, indexed_at, record_id
        ) SELECT
          source_path, source_hash, source_commit, source_modified_at, indexed_at, record_id
        FROM context_index_state_legacy;

        DROP TABLE context_index_state_legacy;
        DROP TABLE context_records_legacy;

        CREATE INDEX context_records_status_idx
          ON context_records(status, kind, updated_at DESC);
        CREATE INDEX context_records_source_idx
          ON context_records(source_kind, source_path);
        CREATE INDEX context_records_key_idx
          ON context_records(record_key, kind, status);

        CREATE VIRTUAL TABLE context_records_fts USING fts5(
          title, summary, symbols, imports, source_path,
          content='context_records', content_rowid='rowid', tokenize='unicode61'
        );
        INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
          SELECT rowid, title, summary, symbols_json, imports_json, source_path
          FROM context_records;

        CREATE TRIGGER context_records_ai AFTER INSERT ON context_records BEGIN
          INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
          VALUES (new.rowid, new.title, new.summary, new.symbols_json, new.imports_json, new.source_path);
        END;
        CREATE TRIGGER context_records_ad AFTER DELETE ON context_records BEGIN
          INSERT INTO context_records_fts(context_records_fts, rowid, title, summary, symbols, imports, source_path)
          VALUES ('delete', old.rowid, old.title, old.summary, old.symbols_json, old.imports_json, old.source_path);
        END;
        CREATE TRIGGER context_records_au
          AFTER UPDATE OF title, summary, symbols_json, imports_json, source_path
          ON context_records BEGIN
          INSERT INTO context_records_fts(context_records_fts, rowid, title, summary, symbols, imports, source_path)
          VALUES ('delete', old.rowid, old.title, old.summary, old.symbols_json, old.imports_json, old.source_path);
          INSERT INTO context_records_fts(rowid, title, summary, symbols, imports, source_path)
          VALUES (new.rowid, new.title, new.summary, new.symbols_json, new.imports_json, new.source_path);
        END;
        COMMIT;
      `);
      committed = true;
    } finally {
      if (!committed) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // The migration may fail before the transaction starts.
        }
      }
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      this.db.exec('COMMIT;');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  get(id: string): ContextRecord | null {
    const row = this.db
      .prepare('SELECT * FROM context_records WHERE id = ?')
      .get(id) as unknown as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  search(query: string, options: SearchOptions = {}): ContextRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const statuses: ContextRecordStatus[] = options.includeProposed
      ? ['confirmed', 'proposed']
      : ['confirmed'];
    const statusPlaceholders = statuses.map(() => '?').join(', ');
    const kindClause = options.kind ? ' AND r.kind = ?' : '';
    const terms = searchTerms(query);
    const strictMatch = ftsQuery(query);
    const fallbackMatch = terms.length > 1 ? ftsQuery(query, ' OR ') : null;
    const parameters: Array<string | number> = [...statuses];
    if (options.kind) {
      parameters.push(options.kind);
    }

    const executeMatch = (match: string, fallback: boolean): ContextRecord[] => {
      const sql = `
        SELECT r.*, bm25(context_records_fts, 2.0, 1.0, 4.0, 0.5, 4.0) AS rank
        FROM context_records_fts
        JOIN context_records r ON r.rowid = context_records_fts.rowid
        WHERE context_records_fts MATCH ?
          AND r.status IN (${statusPlaceholders})
          ${options.includeStale ? '' : 'AND r.stale = 0'}${kindClause}
        ORDER BY rank, r.source_path ASC, r.id ASC
        LIMIT ?
      `;
      const matchParameters = [match, ...parameters, 50];
      const rows = this.db.prepare(sql).all(...matchParameters) as unknown as RecordRow[];
      const candidates: SearchCandidate[] = rows.map((row) => {
        const record = rowToRecord(row);
        return { record, ftsRank: row.rank ?? 0 };
      });
      candidates.sort((left, right) => {
        const leftRank = rankSearchCandidate(left, query, terms, fallback);
        const rightRank = rankSearchCandidate(right, query, terms, fallback);
        for (let index = 0; index < leftRank.length; index += 1) {
          const leftValue = leftRank[index];
          const rightValue = rightRank[index];
          if (leftValue === rightValue) {
            continue;
          }
          if (typeof leftValue === 'string' && typeof rightValue === 'string') {
            return leftValue < rightValue ? -1 : 1;
          }
          return Number(rightValue) - Number(leftValue);
        }
        return 0;
      });
      return candidates.slice(0, limit).map((candidate) => candidate.record);
    };

    if (strictMatch) {
      const strictResults = executeMatch(strictMatch, false);
      if (strictResults.length > 0 || !fallbackMatch) {
        return strictResults;
      }
      return executeMatch(fallbackMatch, true);
    }
    return [];
  }

  getTask(
    taskId: string,
    includeProposed = false,
    includeStale = false,
    limit = 50,
  ): ContextRecord[] {
    const normalized = assertSafeText(
      taskId,
      'taskId',
      TASK_CONTEXT_LIMITS.taskId,
      1,
    );
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const statuses = includeProposed
      ? ['confirmed', 'proposed']
      : ['confirmed'];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM context_records
         WHERE kind = 'task'
           AND (record_key = ? OR id = ? OR title = ?)
           AND status IN (${placeholders})
           ${includeStale ? '' : 'AND stale = 0'}
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(normalized, normalized, normalized, ...statuses, boundedLimit) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  getTaskContext(taskId: string): TaskContext | null {
    const normalized = assertTaskContextText(
      taskId,
      'taskId',
      TASK_CONTEXT_LIMITS.taskId,
    );
    const row = this.db
      .prepare('SELECT * FROM context_task_context WHERE task_id = ?')
      .get(normalized) as unknown as TaskContextRow | undefined;
    return row ? rowToTaskContext(row) : null;
  }

  updateTaskContext(input: TaskContextPatch): TaskContext {
    const taskId = assertTaskContextText(
      input.taskId,
      'taskId',
      TASK_CONTEXT_LIMITS.taskId,
    );
    return this.transaction(() => {
      const existing = this.getTaskContext(taskId);
      const revisionBefore = existing?.revision ?? 0;
      if (
        input.expectedRevision !== undefined &&
        input.expectedRevision !== revisionBefore
      ) {
        throw new Error(
          `Revision conflict for task ${taskId}: expected ${input.expectedRevision}, current ${revisionBefore}.`,
        );
      }
      const objective = input.objective === undefined
        ? existing?.objective
        : assertTaskContextText(
            input.objective,
            'objective',
            TASK_CONTEXT_LIMITS.objective,
          );
      if (!objective) {
        throw new Error('objective is required when creating task context.');
      }
      const context = {
        taskId,
        objective,
        affectedFiles: input.affectedFiles === undefined
          ? existing?.affectedFiles ?? []
          : assertTaskContextItems(
              input.affectedFiles,
              'affectedFiles',
              containsSensitivePathMetadata,
              TASK_CONTEXT_LIMITS.pathItem,
            ),
        architectureDecisions: input.architectureDecisions === undefined
          ? existing?.architectureDecisions ?? []
          : assertTaskContextItems(input.architectureDecisions, 'architectureDecisions'),
        constraints: input.constraints === undefined
          ? existing?.constraints ?? []
          : assertTaskContextItems(input.constraints, 'constraints'),
        completedWork: input.completedWork === undefined
          ? existing?.completedWork ?? []
          : assertTaskContextItems(input.completedWork, 'completedWork'),
        verificationResults: input.verificationResults === undefined
          ? existing?.verificationResults ?? []
          : assertTaskContextItems(input.verificationResults, 'verificationResults'),
        openIssues: input.openIssues === undefined
          ? existing?.openIssues ?? []
          : assertTaskContextItems(input.openIssues, 'openIssues'),
        sourceReferences: input.sourceReferences === undefined
          ? existing?.sourceReferences ?? []
          : assertTaskContextItems(
              input.sourceReferences,
              'sourceReferences',
              containsSensitivePathMetadata,
              TASK_CONTEXT_LIMITS.pathItem,
            ),
      } satisfies Omit<TaskContext, 'createdAt' | 'updatedAt' | 'revision'>;
      if (Buffer.byteLength(JSON.stringify(context), 'utf8') > TASK_CONTEXT_MAX_BYTES) {
        throw new Error(
          `Task context is too large (maximum ${TASK_CONTEXT_MAX_BYTES} bytes); keep the state concise and replace old entries.`,
        );
      }
      if (
        existing &&
        existing.objective === context.objective &&
        JSON.stringify(existing.affectedFiles) === JSON.stringify(context.affectedFiles) &&
        JSON.stringify(existing.architectureDecisions) === JSON.stringify(context.architectureDecisions) &&
        JSON.stringify(existing.constraints) === JSON.stringify(context.constraints) &&
        JSON.stringify(existing.completedWork) === JSON.stringify(context.completedWork) &&
        JSON.stringify(existing.verificationResults) === JSON.stringify(context.verificationResults) &&
        JSON.stringify(existing.openIssues) === JSON.stringify(context.openIssues) &&
        JSON.stringify(existing.sourceReferences) === JSON.stringify(context.sourceReferences)
      ) {
        return existing;
      }
      const timestamp = now();
      const revision = revisionBefore + 1;
      this.db
        .prepare(
          `INSERT INTO context_task_context (
            task_id, objective, affected_files_json, architecture_decisions_json,
            constraints_json, completed_work_json, verification_results_json,
            open_issues_json, source_references_json, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            objective = excluded.objective,
            affected_files_json = excluded.affected_files_json,
            architecture_decisions_json = excluded.architecture_decisions_json,
            constraints_json = excluded.constraints_json,
            completed_work_json = excluded.completed_work_json,
            verification_results_json = excluded.verification_results_json,
            open_issues_json = excluded.open_issues_json,
            source_references_json = excluded.source_references_json,
            updated_at = excluded.updated_at,
            revision = excluded.revision`,
        )
        .run(
          context.taskId,
          context.objective,
          JSON.stringify(context.affectedFiles),
          JSON.stringify(context.architectureDecisions),
          JSON.stringify(context.constraints),
          JSON.stringify(context.completedWork),
          JSON.stringify(context.verificationResults),
          JSON.stringify(context.openIssues),
          JSON.stringify(context.sourceReferences),
          existing?.createdAt ?? timestamp,
          timestamp,
          revision,
        );
      const updated = this.getTaskContext(taskId);
      if (!updated) {
        throw new Error('Failed to read updated task context.');
      }
      return updated;
    });
  }

  upsertIndexedSource(input: IndexedSourceInput): {
    record: ContextRecord;
    created: boolean;
    changed: boolean;
  } {
    if (
      containsSensitivePathMetadata(input.title) ||
      containsSensitivePathMetadata(input.source.path)
    ) {
      throw new Error('Indexed source path contains sensitive metadata.');
    }
    const symbols = stableMetadataItems(assertSafeMetadataItems(input.symbols, 'symbols'));
    const imports = stableMetadataItems(assertSafeMetadataItems(
      input.imports,
      'imports',
      containsSensitivePathMetadata,
    ));
    const symbolsJson = JSON.stringify(symbols);
    const importsJson = JSON.stringify(imports);
    const timestamp = now();
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id, kind, title, summary, symbols_json, imports_json,
                  source_hash, source_commit, source_modified_at, status,
                  stale, invalidation_reason, invalidated_at
           FROM context_records
           WHERE source_kind = 'git' AND source_path = ?
           ORDER BY created_at LIMIT 1`,
        )
        .get(input.source.path) as {
        id: string;
        kind: ContextRecordKind;
        title: string;
        summary: string;
        symbols_json: string;
        imports_json: string;
        source_hash: string;
        source_commit: string;
        source_modified_at: string;
        status: ContextRecordStatus;
        stale: number;
        invalidation_reason: string | null;
        invalidated_at: string | null;
      } | undefined;
      const id = existing?.id ?? randomUUID();
      const contentChanged = existing !== undefined && (
        existing.kind !== input.kind ||
        existing.title !== input.title ||
        existing.summary !== input.summary ||
        existing.symbols_json !== symbolsJson ||
        existing.imports_json !== importsJson ||
        existing.source_hash !== input.source.hash
      );
      if (existing) {
        if (contentChanged) {
          this.db
            .prepare(
              `UPDATE context_records SET
                kind = ?, title = ?, summary = ?, symbols_json = ?, imports_json = ?,
                source_commit = ?, source_hash = ?, source_modified_at = ?,
                status = 'confirmed', stale = 0, invalidation_reason = NULL,
                updated_at = ?, confirmed_at = ?, invalidated_at = NULL
               WHERE id = ?`,
            )
            .run(
              input.kind,
              input.title,
              input.summary,
              symbolsJson,
              importsJson,
              input.source.commit,
              input.source.hash,
              input.source.modifiedAt,
              timestamp,
              timestamp,
              id,
            );
        } else if (
          existing.source_commit !== input.source.commit ||
          existing.source_modified_at !== input.source.modifiedAt ||
          existing.status !== 'confirmed' ||
          existing.stale !== 0 ||
          existing.invalidation_reason !== null ||
          existing.invalidated_at !== null
        ) {
          // Git commit and filesystem mtime are provenance, not indexed content.
          // Keep them current without touching updated_at or the FTS columns.
          this.db
            .prepare(
              `UPDATE context_records SET
                source_commit = ?, source_modified_at = ?,
                status = 'confirmed', stale = 0,
                invalidation_reason = NULL, invalidated_at = NULL
               WHERE id = ?`,
            )
            .run(input.source.commit, input.source.modifiedAt, id);
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO context_records (
              id, kind, title, summary, symbols_json, imports_json,
              source_kind, source_path, source_commit, source_hash,
              source_modified_at, status, stale, created_at, updated_at, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'git', ?, ?, ?, ?, 'confirmed', 0, ?, ?, ?)`,
          )
          .run(
            id,
            input.kind,
            input.title,
            input.summary,
            symbolsJson,
            importsJson,
            input.source.path,
            input.source.commit,
            input.source.hash,
            input.source.modifiedAt,
            timestamp,
            timestamp,
            timestamp,
          );
      }
      this.db
        .prepare(
          `INSERT INTO context_index_state (
            source_path, source_hash, source_commit, source_modified_at, indexed_at, record_id
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_path) DO UPDATE SET
            source_hash = excluded.source_hash,
            source_commit = excluded.source_commit,
            source_modified_at = excluded.source_modified_at,
            indexed_at = excluded.indexed_at,
            record_id = excluded.record_id`,
        )
        .run(
          input.source.path,
          input.source.hash,
          input.source.commit,
          input.source.modifiedAt,
          timestamp,
          id,
        );
      const record = this.get(id);
      if (!record) {
        throw new Error('Failed to read indexed context record.');
      }
      return { record, created: !existing, changed: contentChanged || !existing };
    });
  }

  createProposal(input: ProposalInput): ContextRecord {
    if (containsSensitivePathMetadata(input.source.path)) {
      throw new Error('sourcePath may contain a secret or personal data.');
    }
    const id = randomUUID();
    const timestamp = now();
    const title = assertSafeText(input.title, 'title', 160, 1);
    const summary = assertSafeText(input.summary, 'summary', 1200, 12);
    const key = assertRecordKey(input.key);
    this.db
      .prepare(
        `INSERT INTO context_records (
          id, record_key, kind, title, summary, source_kind, source_path,
          source_commit, source_hash, source_modified_at, status, stale,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 'proposed', 0, ?, ?)`,
      )
      .run(
        id,
        key,
        input.kind,
        title,
        summary,
        input.source.path,
        input.source.commit,
        input.source.hash,
        input.source.modifiedAt,
        timestamp,
        timestamp,
      );
    const record = this.get(id);
    if (!record) {
      throw new Error('Failed to read proposed context record.');
    }
    return record;
  }

  proposeUpdate(id: string, patch: ProposalPatch): ContextRecord {
    return this.transaction(() => {
      const existing = this.get(id);
      if (!existing || existing.status !== 'confirmed') {
        throw new Error(`Context record ${id} must be confirmed before update.`);
      }
      if (existing.sourceKind === 'git' || existing.kind === 'source') {
        throw new Error('Derived source records are updated by the indexer.');
      }
      const proposal = this.createProposal({
        key: patch.key ?? existing.key ?? undefined,
        kind: patch.kind ?? existing.kind,
        title: patch.title ?? existing.title,
        summary: patch.summary ?? existing.summary,
        source: patch.source,
      });
      this.db
        .prepare('UPDATE context_records SET supersedes_id = ? WHERE id = ?')
        .run(existing.id, proposal.id);
      const updatedProposal = this.get(proposal.id);
      if (!updatedProposal) {
        throw new Error('Failed to read updated proposal.');
      }
      return updatedProposal;
    });
  }

  confirm(id: string, currentSource: SourceSnapshot): ContextRecord {
    return this.transaction(() => {
      const record = this.get(id);
      if (!record || record.status !== 'proposed') {
        throw new Error(`Context record ${id} is not proposed.`);
      }
      if (
        record.source.path !== currentSource.path ||
        record.source.hash !== currentSource.hash
      ) {
        throw new Error(
          'The proposal source changed after it was saved. Review it and create a new proposal.',
        );
      }
      const timestamp = now();
      if (record.supersedesId) {
        const superseded = this.db
          .prepare(
            `UPDATE context_records SET status = 'invalidated', stale = 0,
              invalidation_reason = 'Superseded by a confirmed proposal',
              invalidated_at = ?, updated_at = ?
             WHERE id = ? AND status = 'confirmed'`,
          )
          .run(timestamp, timestamp, record.supersedesId);
        if (Number(superseded.changes) !== 1) {
          throw new Error('The record was already superseded; review the latest version.');
        }
      }
      const promoted = this.db
        .prepare(
          `UPDATE context_records SET status = 'confirmed', stale = 0,
            source_commit = ?, source_modified_at = ?, confirmed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'proposed'`,
        )
        .run(
          currentSource.commit,
          currentSource.modifiedAt,
          timestamp,
          timestamp,
          id,
        );
      if (Number(promoted.changes) !== 1) {
        throw new Error('The proposal was already reviewed.');
      }
      const confirmed = this.get(id);
      if (!confirmed) {
        throw new Error('Failed to read confirmed context record.');
      }
      return confirmed;
    });
  }

  invalidate(id: string, reason = 'Invalidated through the context API'): ContextRecord {
    const record = this.get(id);
    if (!record) {
      throw new Error(`Context record ${id} was not found.`);
    }
    const safeReason = assertSafeText(reason, 'reason', 240, 2);
    const timestamp = now();
    this.db
      .prepare(
        `UPDATE context_records SET status = 'invalidated', stale = 0,
          invalidation_reason = ?, invalidated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(safeReason, timestamp, timestamp, id);
    const invalidated = this.get(id);
    if (!invalidated) {
      throw new Error('Failed to read invalidated context record.');
    }
    return invalidated;
  }

  indexedSourceHashes(): Map<string, string> {
    const rows = this.db
      .prepare('SELECT source_path, source_hash FROM context_index_state')
      .all() as unknown as Array<{ source_path: string; source_hash: string }>;
    return new Map(rows.map((row) => [row.source_path, row.source_hash]));
  }

  lastIndexedCommit(): string | null {
    const row = this.db
      .prepare("SELECT value FROM context_metadata WHERE key = 'last_indexed_commit'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  activeSourceReferences(): StoredSourceReference[] {
    const rows = this.db
      .prepare(
        `SELECT id, source_path, source_commit, source_hash
         FROM context_records
         WHERE status IN ('confirmed', 'proposed')`,
      )
      .all() as unknown as Array<{
      id: string;
      source_path: string;
      source_commit: string;
      source_hash: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.source_path,
      commit: row.source_commit,
      hash: row.source_hash,
    }));
  }

  setStaleness(staleness: ReadonlyMap<string, boolean>): number {
    if (staleness.size === 0) {
      return 0;
    }
    const update = this.db.prepare(
      'UPDATE context_records SET stale = ?, updated_at = ? WHERE id = ? AND stale != ?',
    );
    const timestamp = now();
    let changed = 0;
    this.transaction(() => {
      for (const [id, stale] of staleness) {
        const value = stale ? 1 : 0;
        const result = update.run(value, timestamp, id, value);
        changed += Number(result.changes);
      }
    });
    return changed;
  }

  invalidateMissingIndexedSources(currentPaths: ReadonlySet<string>): number {
    const rows = this.db
      .prepare('SELECT source_path, record_id FROM context_index_state')
      .all() as unknown as Array<{ source_path: string; record_id: string }>;
    const missing = rows.filter((row) => !currentPaths.has(row.source_path));
    if (missing.length === 0) {
      return 0;
    }
    this.transaction(() => {
      const removeState = this.db.prepare('DELETE FROM context_index_state WHERE source_path = ?');
      const removeRecord = this.db.prepare(
        "DELETE FROM context_records WHERE id = ? AND source_kind = 'git'",
      );
      for (const row of missing) {
        removeState.run(row.source_path);
        removeRecord.run(row.record_id);
      }
    });
    return missing.length;
  }

  setIndexMetadata(commit: string, indexedAt: string): void {
    const statement = this.db.prepare(
      `INSERT INTO context_metadata(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.transaction(() => {
      statement.run('last_indexed_commit', commit);
      statement.run('last_indexed_at', indexedAt);
    });
  }

  resetDerived(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM context_records WHERE source_kind = 'git'")
      .get() as { count: number };
    this.transaction(() => {
      this.db.exec("DELETE FROM context_records WHERE source_kind = 'git';");
      this.db.exec('DELETE FROM context_index_state;');
      this.db.exec(
        "DELETE FROM context_metadata WHERE key IN ('last_indexed_commit', 'last_indexed_at');",
      );
    });
    return Number(row.count);
  }

  recordAudit(input: AuditLogInput): void {
    const requestBytes = Math.max(0, Math.round(input.requestBytes));
    const durationMs = Math.max(0, Math.round(input.durationMs));
    const resultCount = Math.max(0, Math.round(input.resultCount));
    const responseBytes = Math.max(0, Math.round(input.responseBytes));
    const taskId = sanitizeAuditContext(input.taskId, 160);
    const agentRole = sanitizeAuditContext(input.agentRole, 80);
    this.db
      .prepare(
        `INSERT INTO context_audit_log (
          occurred_at, tool, task_id, agent_role, request_bytes, duration_ms,
          result_count, response_bytes, success, revision_before, revision_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.occurredAt,
        input.tool,
        taskId,
        agentRole,
        requestBytes,
        durationMs,
        resultCount,
        responseBytes,
        input.success ? 1 : 0,
        input.revisionBefore ?? null,
        input.revisionAfter ?? null,
      );
  }

  auditStats(options: AuditStatsOptions = {}): AuditStats {
    const clauses: string[] = ['1 = 1'];
    const parameters: Array<string> = [];
    if (options.tool) {
      clauses.push('tool = ?');
      parameters.push(options.tool);
    }
    if (options.taskId) {
      clauses.push('task_id = ?');
      parameters.push(options.taskId);
    }
    if (options.agentRole) {
      clauses.push('agent_role = ?');
      parameters.push(options.agentRole);
    }
    if (options.since) {
      clauses.push('occurred_at >= ?');
      parameters.push(options.since);
    }
    if (options.until) {
      clauses.push('occurred_at <= ?');
      parameters.push(options.until);
    }
    const where = clauses.join(' AND ');
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS calls,
           COALESCE(SUM(success), 0) AS successful_calls,
           COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
           COALESCE(SUM(result_count), 0) AS result_count,
           COALESCE(SUM(request_bytes), 0) AS request_bytes,
           COALESCE(SUM(response_bytes), 0) AS response_bytes,
           COALESCE(AVG(duration_ms), 0) AS average_duration_ms,
           MAX(occurred_at) AS latest_at
         FROM context_audit_log
         WHERE ${where}`,
      )
      .get(...parameters) as {
      calls: number;
      successful_calls: number;
      failed_calls: number;
      result_count: number;
      request_bytes: number;
      response_bytes: number;
      average_duration_ms: number;
      latest_at: string | null;
    };
    const byTool = {} as Record<AuditToolName, AuditToolStats>;
    const tools: AuditToolName[] = [
      'context.search',
      'context.get',
      'context.get_task',
      'context.update_task_context',
    ];
    for (const tool of tools) {
      byTool[tool] = {
        calls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        resultCount: 0,
        requestBytes: 0,
        responseBytes: 0,
        averageDurationMs: 0,
        latestAt: null,
      };
    }
    const toolRows = this.db
      .prepare(
        `SELECT
           tool,
           COUNT(*) AS calls,
           COALESCE(SUM(success), 0) AS successful_calls,
           COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS failed_calls,
           COALESCE(SUM(result_count), 0) AS result_count,
           COALESCE(SUM(request_bytes), 0) AS request_bytes,
           COALESCE(SUM(response_bytes), 0) AS response_bytes,
           COALESCE(AVG(duration_ms), 0) AS average_duration_ms,
           MAX(occurred_at) AS latest_at
         FROM context_audit_log
         WHERE ${where}
         GROUP BY tool`,
      )
      .all(...parameters) as unknown as Array<{
      tool: AuditToolName;
      calls: number;
      successful_calls: number;
      failed_calls: number;
      result_count: number;
      request_bytes: number;
      response_bytes: number;
      average_duration_ms: number;
      latest_at: string | null;
    }>;
    for (const row of toolRows) {
      byTool[row.tool] = {
        calls: Number(row.calls),
        successfulCalls: Number(row.successful_calls),
        failedCalls: Number(row.failed_calls),
        resultCount: Number(row.result_count),
        requestBytes: Number(row.request_bytes),
        responseBytes: Number(row.response_bytes),
        averageDurationMs: Number(Number(row.average_duration_ms).toFixed(2)),
        latestAt: row.latest_at,
      };
    }
    return {
      totalCalls: Number(totals.calls),
      successfulCalls: Number(totals.successful_calls),
      failedCalls: Number(totals.failed_calls),
      resultCount: Number(totals.result_count),
      requestBytes: Number(totals.request_bytes),
      responseBytes: Number(totals.response_bytes),
      averageDurationMs: Number(Number(totals.average_duration_ms).toFixed(2)),
      latestAt: totals.latest_at,
      byTool,
    };
  }

  status(): StoreStatus {
    const counts: Record<ContextRecordStatus, number> = {
      confirmed: 0,
      proposed: 0,
      invalidated: 0,
    };
    const countRows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM context_records GROUP BY status')
      .all() as unknown as Array<{ status: ContextRecordStatus; count: number }>;
    for (const row of countRows) {
      counts[row.status] = Number(row.count);
    }
    const stale = this.db
      .prepare('SELECT COUNT(*) AS count FROM context_records WHERE stale = 1')
      .get() as { count: number };
    const indexed = this.db
      .prepare('SELECT COUNT(*) AS count FROM context_index_state')
      .get() as { count: number };
    const metadataRows = this.db
      .prepare(
        "SELECT key, value FROM context_metadata WHERE key IN ('last_indexed_commit', 'last_indexed_at')",
      )
      .all() as unknown as Array<{ key: string; value: string }>;
    const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
    const journal = this.db.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    return {
      databasePath: this.databasePath,
      journalMode: journal.journal_mode,
      counts,
      stale: Number(stale.count),
      indexedSources: Number(indexed.count),
      lastIndexedAt: metadata.get('last_indexed_at') ?? null,
      lastIndexedCommit: metadata.get('last_indexed_commit') ?? null,
    };
  }
}
