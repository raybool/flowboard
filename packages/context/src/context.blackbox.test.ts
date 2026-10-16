import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  default as fs,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { GitContextIndexer } from './indexer.js';
import { ContextStore } from './store.js';

const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
const serverPath = fileURLToPath(new URL('./server.js', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);

interface Fixture {
  root: string;
  databasePath: string;
  outside: string;
}

interface ToolRecord {
  id: string;
  key: string | null;
  kind: string;
  title: string;
  summary: string;
  status: string;
  stale: boolean;
  freshness?: 'fresh' | 'stale' | 'unknown';
  source: { path: string; hash: string };
  supersedesId: string | null;
}

interface ToolPayload {
  record?: ToolRecord;
  records?: ToolRecord[];
  taskContext?: {
    task_id: string;
    objective: string;
    affected_files: string[];
    architecture_decisions: string[];
    constraints: string[];
    completed_work: string[];
    verification_results: string[];
    open_issues: string[];
    source_references: string[];
    revision: number;
  } | null;
  freshness?: {
    checked: number;
    fresh: number;
    stale: number;
    unknown: number;
    changed: number;
    staleIds?: string[];
    unknownIds?: string[];
  };
  source_references_freshness?: {
    checked: number;
    fresh: number;
    stale: number;
    unknown: number;
    staleIds?: string[];
    unknownIds?: string[];
  };
  returnedCount?: number;
  totalCount?: number;
  omittedCount?: number;
  truncated?: boolean;
  hasMore?: boolean;
  truncationReason?: string | null;
}

interface AuditRow {
  occurredAt: string;
  tool: string;
  taskId: string | null;
  agentRole: string | null;
  requestBytes: number;
  durationMs: number;
  resultCount: number;
  responseBytes: number;
  success: number;
  revisionBefore: number | null;
  revisionAfter: number | null;
  retryCount?: number;
  errorCode?: string | null;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'flowboard-context-test-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'flowboard-context-outside-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'FlowBoard QA']);
  git(root, ['config', 'user.email', 'qa@example.invalid']);
  writeFileSync(
    path.join(root, '.gitignore'),
    '.env*\n.codex/\nnode_modules/\ndist/\n',
  );
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'src', 'alpha.ts'),
    'export function AlphaNeedle(): string { return "alpha"; }\n',
  );
  writeFileSync(
    path.join(root, 'README.md'),
    '# Fixture\n\nLocal context integration fixture.\n',
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return {
    root,
    outside,
    databasePath: path.join(root, '.codex', 'context-test.sqlite'),
  };
}

function contextEnv(fixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLOWBOARD_CONTEXT_ROOT: fixture.root,
    FLOWBOARD_CONTEXT_DB: fixture.databasePath,
  };
}

function cli<T>(fixture: Fixture, ...args: string[]): T {
  return JSON.parse(
    execFileSync(process.execPath, [cliPath, ...args], {
      cwd: fixture.root,
      env: contextEnv(fixture),
      encoding: 'utf8',
    }),
  ) as T;
}

async function cliAsync(fixture: Fixture, ...args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd: fixture.root,
    env: contextEnv(fixture),
    encoding: 'utf8',
  });
  return result.stdout;
}

function databaseRecord(
  fixture: Fixture,
  id: string,
): { stale: number; status: string; updatedAt: string } {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        'SELECT stale, status, updated_at AS updatedAt FROM context_records WHERE id = ?',
      )
      .get(id) as
      | { stale: number; status: string; updatedAt: string }
      | undefined;
    assert.ok(row, `Missing context record ${id}`);
    return row;
  } finally {
    database.close();
  }
}

function databaseAuditRows(fixture: Fixture): AuditRow[] {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT occurred_at AS occurredAt, tool, task_id AS taskId,
                agent_role AS agentRole, request_bytes AS requestBytes,
                duration_ms AS durationMs,
                result_count AS resultCount, response_bytes AS responseBytes,
                success, revision_before AS revisionBefore,
                revision_after AS revisionAfter,
                retry_count AS retryCount, error_code AS errorCode
         FROM context_audit_log
         ORDER BY id`,
      )
      .all() as unknown as AuditRow[];
  } finally {
    database.close();
  }
}

async function connectClient(
  fixture: Fixture,
  name: string,
  envOverrides: Record<string, string> = {},
) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: fixture.root,
    env: { ...contextEnv(fixture), ...envOverrides } as Record<string, string>,
    stderr: 'pipe',
  });
  await client.connect(transport);
  return { client, transport };
}

function structuredPayload(result: Awaited<ReturnType<Client['callTool']>>): ToolPayload {
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as ToolPayload;
}

async function expectToolFailure(
  action: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    const value = (await action()) as { isError?: boolean; content?: unknown };
    assert.equal(value.isError, true, `Expected an MCP error, received ${JSON.stringify(value)}`);
    assert.match(JSON.stringify(value.content), pattern);
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), pattern);
  }
}

test('MCP contract, FTS, persistence, staleness, incremental update, and safety', async (t) => {
  const fixture = createFixture();
  const initial = cli<{
    created: number;
    scanned: number;
    skipped: number;
  }>(fixture, 'index');
  assert.ok(initial.created >= 2);
  assert.ok(initial.scanned >= 2);

  const alphaBefore = cli<{ records: ToolRecord[] }>(fixture, 'search', 'AlphaNeedle').records[0];
  assert.ok(alphaBefore);
  const recordBeforeNoop = databaseRecord(fixture, alphaBefore.id);
  const beforeNoop = cli<{ lastIndexedAt: string | null }>(fixture, 'status');
  const unchanged = cli<{ unchanged: number; updated: number }>(fixture, 'index');
  assert.ok(unchanged.unchanged >= 2);
  assert.equal(unchanged.updated, 0);
  const afterNoop = cli<{ lastIndexedAt: string | null }>(fixture, 'status');
  assert.equal(afterNoop.lastIndexedAt, beforeNoop.lastIndexedAt);
  assert.equal(databaseRecord(fixture, alphaBefore.id).updatedAt, recordBeforeNoop.updatedAt);

  git(fixture.root, ['commit', '--allow-empty', '-qm', 'metadata-only head']);
  const newHead = cli<{ unchanged: number; updated: number }>(fixture, 'index');
  assert.equal(newHead.updated, 0);
  assert.ok(newHead.unchanged >= 2);

  const first = await connectClient(fixture, 'flowboard-qa-first');
  t.after(async () => first.client.close());

  const listed = await first.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      'context.get',
      'context.get_task',
      'context.invalidate',
      'context.save',
      'context.search',
      'context.update',
      'context.update_task_context',
    ],
  );
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description);
    if (['context.get', 'context.get_task', 'context.search'].includes(tool.name)) {
      assert.equal(tool.annotations?.readOnlyHint, true);
    } else {
      assert.equal(tool.annotations?.readOnlyHint, false);
      assert.equal(tool.annotations?.destructiveHint, false);
    }
  }

  const alphaSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'AlphaNeedle' },
    }),
  );
  assert.equal(alphaSearch.records?.length, 1);
  const alpha = alphaSearch.records?.[0];
  assert.ok(alpha);
  assert.equal(alpha.source.path, 'src/alpha.ts');
  assert.equal(alpha.status, 'confirmed');
  assert.equal(alpha.stale, false);
  assert.equal(alpha.freshness, 'fresh');

  writeFileSync(
    path.join(fixture.root, 'src', 'alpha.ts'),
    'export function BetaNeedle(): string { return "beta"; }\n',
  );
  const staleStatus = cli<{
    freshness: { stale: number; changed: number };
    stale: number;
  }>(fixture, 'status');
  assert.ok(staleStatus.freshness.stale >= 1);
  assert.ok(staleStatus.stale >= 1);

  const staleSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'AlphaNeedle' },
    }),
  );
  assert.equal(staleSearch.records?.length, 0);
  assert.ok((staleSearch.freshness?.stale ?? 0) >= 1);

  const staleGet = structuredPayload(
    await first.client.callTool({
      name: 'context.get',
      arguments: { id: alpha.id },
    }),
  );
  assert.equal(staleGet.record?.id, alpha.id);
  assert.equal(staleGet.record?.stale, true);
  assert.equal(staleGet.record?.freshness, 'stale');

  const refreshed = cli<{ updated: number }>(fixture, 'update');
  assert.ok(refreshed.updated >= 1);
  const betaSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'BetaNeedle' },
    }),
  );
  assert.equal(betaSearch.records?.length, 1);
  assert.equal(betaSearch.records?.[0]?.id, alpha.id);
  assert.equal(betaSearch.records?.[0]?.stale, false);

  writeFileSync(
    path.join(fixture.root, 'src', 'alpha.ts'),
    'export function GammaNeedle(): string { return "gamma"; }\n',
  );
  const pureRead = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'BetaNeedle' },
    }),
  );
  assert.equal(pureRead.records?.length, 0);
  const notPersisted = cli<{ freshness: { changed: number } }>(fixture, 'status');
  assert.ok(notPersisted.freshness.changed >= 1, 'MCP read must not write stale flags');
  cli(fixture, 'update');

  writeFileSync(
    path.join(fixture.root, 'src', 'untracked.ts'),
    'export const UntrackedNeedle = "visible";\n',
  );
  const untrackedUpdate = cli<{ created: number }>(fixture, 'update');
  assert.ok(untrackedUpdate.created >= 1);
  const untrackedSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'UntrackedNeedle' },
    }),
  );
  assert.equal(untrackedSearch.records?.[0]?.source.path, 'src/untracked.ts');

  const saved = structuredPayload(
    await first.client.callTool({
      name: 'context.save',
      arguments: {
        title: 'FB-008 русский контекст',
        summary: 'Локальный индекс сохраняет решения между сессиями.',
        sourcePath: 'README.md',
        kind: 'task',
        key: 'FB-008',
      },
    }),
  );
  const proposal = saved.record;
  assert.ok(proposal);
  assert.equal(proposal.status, 'proposed');

  const hiddenProposal = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'русский' },
    }),
  );
  assert.equal(hiddenProposal.records?.length, 0);
  const visibleProposal = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'русский', includeProposed: true },
    }),
  );
  assert.equal(visibleProposal.records?.[0]?.id, proposal.id);

  const confirmed = cli<{ record: ToolRecord }>(fixture, 'confirm', proposal.id);
  assert.equal(confirmed.record.status, 'confirmed');

  const architecture = structuredPayload(
    await first.client.callTool({
      name: 'context.save',
      arguments: {
        title: 'System layout',
        summary: 'The fixture has one source module.',
        sourcePath: 'README.md',
        kind: 'architecture',
      },
    }),
  ).record;
  assert.ok(architecture);
  cli(fixture, 'confirm', architecture.id);
  const architectureSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'System', kind: 'architecture' },
    }),
  );
  assert.equal(architectureSearch.records?.[0]?.id, architecture.id);

  const task = structuredPayload(
    await first.client.callTool({
      name: 'context.get_task',
      arguments: { taskId: 'FB-008' },
    }),
  );
  assert.equal(task.records?.[0]?.id, proposal.id);

  const second = await connectClient(fixture, 'flowboard-qa-second');
  t.after(async () => second.client.close());
  const [parallelSearch, parallelGet] = await Promise.all([
    first.client.callTool({
      name: 'context.search',
      arguments: { query: 'русский' },
    }),
    second.client.callTool({
      name: 'context.get',
      arguments: { id: proposal.id },
    }),
  ]);
  assert.equal(structuredPayload(parallelSearch).records?.[0]?.id, proposal.id);
  assert.equal(structuredPayload(parallelGet).record?.id, proposal.id);

  const replacement = structuredPayload(
    await second.client.callTool({
      name: 'context.update',
      arguments: {
        id: proposal.id,
        summary: 'Локальный индекс устойчиво сохраняет решения между сессиями.',
      },
    }),
  ).record;
  assert.ok(replacement);
  assert.equal(replacement.status, 'proposed');
  assert.equal(replacement.supersedesId, proposal.id);
  assert.equal(
    structuredPayload(
      await first.client.callTool({
        name: 'context.get',
        arguments: { id: proposal.id },
      }),
    ).record?.status,
    'confirmed',
  );
  const replacementConfirmed = cli<{ record: ToolRecord }>(
    fixture,
    'confirm',
    replacement.id,
  );
  assert.equal(replacementConfirmed.record.status, 'confirmed');
  assert.equal(
    structuredPayload(
      await first.client.callTool({
        name: 'context.get',
        arguments: { id: proposal.id },
      }),
    ).record?.status,
    'invalidated',
  );

  const invalidated = structuredPayload(
    await second.client.callTool({
      name: 'context.invalidate',
      arguments: { id: replacement.id, reason: 'QA lifecycle complete' },
    }),
  );
  assert.equal(invalidated.record?.status, 'invalidated');

  writeFileSync(
    path.join(fixture.outside, 'escape.ts'),
    'export const OutsideNeedle = true;\n',
  );
  symlinkSync(fixture.outside, path.join(fixture.root, 'linked-outside'));
  await expectToolFailure(
    () =>
      first.client.callTool({
        name: 'context.save',
        arguments: {
          title: 'Unsafe source',
          summary: 'This must never be saved.',
          sourcePath: 'linked-outside/escape.ts',
        },
      }),
    /outside|repository root|symlink|eligible/iu,
  );

  writeFileSync(path.join(fixture.root, '.env'), 'API_KEY=secret-value-123456789\n');
  writeFileSync(
    path.join(fixture.root, 'src', `ghp_${'A'.repeat(36)}.ts`),
    'export const HiddenNeedle = true;\n',
  );
  writeFileSync(
    path.join(fixture.root, 'src', 'secret.ts'),
    'export const API_KEY = "secret-value-123456789";\n',
  );
  const securityUpdate = cli<{ skipped: number }>(fixture, 'update');
  assert.ok(securityUpdate.skipped >= 3);
  const secretSearch = structuredPayload(
    await first.client.callTool({
      name: 'context.search',
      arguments: { query: 'secret-value' },
    }),
  );
  assert.equal(secretSearch.records?.length, 0);
  assert.equal(
    structuredPayload(await first.client.callTool({
      name: 'context.search', arguments: { query: 'HiddenNeedle' },
    })).records?.length,
    0,
  );
  await expectToolFailure(
    () =>
      first.client.callTool({
        name: 'context.save',
        arguments: {
          title: 'Credential note',
          summary: 'api_key=secret-value-123456789',
          sourcePath: 'README.md',
        },
      }),
    /secret|personal data/iu,
  );

  const dbHeader = readFileSync(fixture.databasePath).subarray(0, 16).toString('utf8');
  assert.equal(dbHeader, 'SQLite format 3\u0000');
});

test('incremental index creates, updates, and removes nested source files', () => {
  const fixture = createFixture();
  cli(fixture, 'index');

  const authModulePath = path.join(
    fixture.root,
    'src',
    'modules',
    'auth',
    'auth.module.ts',
  );
  const guardPath = path.join(
    fixture.root,
    'src',
    'modules',
    'auth',
    'guards',
    'access-token.guard.ts',
  );
  mkdirSync(path.dirname(authModulePath), { recursive: true });
  mkdirSync(path.dirname(guardPath), { recursive: true });
  writeFileSync(
    authModulePath,
    'import { AccessTokenGuardNeedle } from "./guards/access-token.guard";\n' +
      'export class AuthModuleNeedle {\n' +
      '  public readonly guard = AccessTokenGuardNeedle;\n' +
      '}\n',
  );
  writeFileSync(
    guardPath,
    'export class AccessTokenGuardNeedle {\n  public readonly name = "guard";\n}\n',
  );

  const created = cli<{ created: number }>(fixture, 'update');
  assert.ok(created.created >= 2);
  const createdModule = cli<{ count: number; records: ToolRecord[] }>(
    fixture,
    'search',
    'AuthModuleNeedle',
  );
  assert.equal(createdModule.count, 1);
  assert.equal(createdModule.records[0]?.source.path, 'src/modules/auth/auth.module.ts');
  const createdGuard = cli<{ count: number; records: ToolRecord[] }>(
    fixture,
    'search',
    'AccessTokenGuardNeedle',
  );
  assert.equal(createdGuard.count, 1);
  assert.equal(
    createdGuard.records[0]?.source.path,
    'src/modules/auth/guards/access-token.guard.ts',
  );

  const renamedModulePath = path.join(
    fixture.root,
    'src',
    'modules',
    'auth',
    'auth.renamed.ts',
  );
  fs.renameSync(authModulePath, renamedModulePath);
  const renamedFreshness = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((renamedFreshness.freshness?.stale ?? 0) >= 1);
  const renamed = cli<{ created: number; invalidated: number }>(fixture, 'update');
  assert.ok(renamed.created >= 1);
  assert.ok(renamed.invalidated >= 1);
  const renamedSearch = cli<{ count: number; records: ToolRecord[] }>(
    fixture,
    'search',
    'AuthModuleNeedle',
  );
  assert.equal(
    renamedSearch.count,
    1,
  );
  assert.equal(
    renamedSearch.records[0]?.source.path,
    'src/modules/auth/auth.renamed.ts',
  );

  const excludedPath = path.join(fixture.root, 'src', 'generated', 'IgnoredNeedle.ts');
  mkdirSync(path.dirname(excludedPath), { recursive: true });
  writeFileSync(excludedPath, 'export class IgnoredNeedle {}\n');
  const excluded = cli<{ skipped: number }>(fixture, 'update');
  assert.ok(excluded.skipped >= 1);
  assert.equal(cli<{ count: number }>(fixture, 'search', 'IgnoredNeedle').count, 0);

  writeFileSync(
    renamedModulePath,
    'export class AuthModuleChangedNeedle {\n  public readonly name = "changed";\n}\n',
  );
  const updated = cli<{ updated: number }>(fixture, 'update');
  assert.ok(updated.updated >= 1);
  assert.equal(cli<{ count: number }>(fixture, 'search', 'AuthModuleNeedle').count, 0);
  assert.equal(
    cli<{ count: number; records: ToolRecord[] }>(fixture, 'search', 'AuthModuleChangedNeedle')
      .records[0]?.source.path,
    'src/modules/auth/auth.renamed.ts',
  );

  fs.unlinkSync(guardPath);
  const deleted = cli<{ invalidated: number }>(fixture, 'update');
  assert.ok(deleted.invalidated >= 1);
  assert.equal(cli<{ count: number }>(fixture, 'search', 'AccessTokenGuardNeedle').count, 0);
});

test('freshness is worktree-aware for staged, unstaged, deleted, and unverifiable sources', async (t) => {
  const fixture = createFixture();
  cli(fixture, 'index');

  const alphaPath = path.join(fixture.root, 'src', 'alpha.ts');
  const indexed = cli<{ records: ToolRecord[] }>(fixture, 'search', 'AlphaNeedle');
  const alpha = indexed.records[0];
  assert.ok(alpha);
  assert.equal(alpha.source.hash, createHash('sha256').update(readFileSync(alphaPath)).digest('hex'));

  const unchanged = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.equal(unchanged.freshness?.fresh, unchanged.freshness?.checked);
  assert.equal(unchanged.freshness?.stale, 0);
  assert.equal(unchanged.freshness?.unknown, 0);

  writeFileSync(alphaPath, 'export function UnstagedNeedle(): string { return "unstaged"; }\n');
  const unstaged = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((unstaged.freshness?.stale ?? 0) >= 1);
  assert.equal(unstaged.freshness?.unknown, 0);

  const reindexed = cli<{ updated: number }>(fixture, 'update');
  assert.ok(reindexed.updated >= 1);
  const afterUnstaged = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.equal(afterUnstaged.freshness?.stale, 0);
  assert.equal(afterUnstaged.freshness?.unknown, 0);

  writeFileSync(alphaPath, 'export function StagedNeedle(): string { return "staged"; }\n');
  git(fixture.root, ['add', 'src/alpha.ts']);
  const staged = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((staged.freshness?.stale ?? 0) >= 1);
  assert.equal(staged.freshness?.unknown, 0);

  git(fixture.root, ['commit', '-qm', 'staged content']);
  const committed = cli<{ updated: number }>(fixture, 'update');
  assert.ok(committed.updated >= 1);
  git(fixture.root, ['commit', '--allow-empty', '-qm', 'metadata-only head']);
  const sameContentNewCommit = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.equal(sameContentNewCommit.freshness?.stale, 0);
  assert.equal(sameContentNewCommit.freshness?.unknown, 0);

  fs.unlinkSync(alphaPath);
  const deleted = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((deleted.freshness?.stale ?? 0) >= 1);

  writeFileSync(alphaPath, 'x'.repeat(512 * 1024 + 1));
  const unreadable = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((unreadable.freshness?.unknown ?? 0) >= 1);
  assert.equal(unreadable.freshness?.stale, 0);

  const database = new DatabaseSync(fixture.databasePath);
  try {
    database.prepare('UPDATE context_records SET source_hash = ? WHERE id = ?').run('0'.repeat(40), alpha.id);
  } finally {
    database.close();
  }
  writeFileSync(alphaPath, 'export function RestoredNeedle(): string { return "restored"; }\n');
  const incompatibleHash = cli<{ freshness: ToolPayload['freshness'] }>(fixture, 'status');
  assert.ok((incompatibleHash.freshness?.unknown ?? 0) >= 1);
  assert.ok(
    (incompatibleHash.freshness?.fresh ?? 0) < (incompatibleHash.freshness?.checked ?? 0),
  );

  const connection = await connectClient(fixture, 'flowboard-freshness-test');
  t.after(async () => connection.client.close());
  const unknownRecord = structuredPayload(
    await connection.client.callTool({
      name: 'context.get',
      arguments: { id: alpha.id },
    }),
  ).record;
  assert.equal(unknownRecord?.freshness, 'unknown');
  assert.equal(unknownRecord?.stale, false);
});

test('MCP read audit records safe metrics and CLI stats', async (t) => {
  const fixture = createFixture();
  cli(fixture, 'index');
  const connection = await connectClient(fixture, 'flowboard-audit-test');
  t.after(async () => connection.client.close());

  const search = structuredPayload(
    await connection.client.callTool({
      name: 'context.search',
      arguments: {
        query: 'AlphaNeedle',
        task_id: 'FB-003.2',
        agent_role: 'developer',
      },
    }),
  );
  const record = search.records?.[0];
  assert.ok(record);
  structuredPayload(
    await connection.client.callTool({
      name: 'context.get',
      arguments: {
        id: record.id,
        task_id: 'FB-003.2',
        agent_role: 'reviewer',
      },
    }),
  );
  const saved = structuredPayload(
    await connection.client.callTool({
      name: 'context.save',
      arguments: {
        title: 'FB-003.2 audit fixture',
        summary: 'Audit fixture task record.',
        sourcePath: 'README.md',
        kind: 'task',
        key: 'FB-003.2',
      },
    }),
  );
  assert.ok(saved.record);
  structuredPayload(
    await connection.client.callTool({
      name: 'context.get_task',
      arguments: {
        taskId: 'FB-003.2',
        includeProposed: true,
        task_id: 'FB-003.2',
        agent_role: 'qa',
      },
    }),
  );
  // The sensitive value is accepted by the tool schema but must not be persisted.
  structuredPayload(
    await connection.client.callTool({
      name: 'context.search',
      arguments: {
        query: 'AlphaNeedle',
        task_id: 'JWT_SECRET=do-not-store',
        agent_role: 'developer',
      },
    }),
  );

  const rows = databaseAuditRows(fixture);
  const scopedRows = rows.filter((row) => row.taskId === 'FB-003.2');
  assert.equal(scopedRows.length, 3);
  assert.deepEqual(
    scopedRows.map((row) => row.tool),
    ['context.search', 'context.get', 'context.get_task'],
  );
  for (const row of scopedRows) {
    assert.match(row.occurredAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.ok(row.durationMs >= 0);
    assert.ok(row.responseBytes > 0);
    assert.equal(row.success, 1);
  }
  assert.equal(scopedRows[0]?.resultCount, 1);
  assert.equal(scopedRows[1]?.resultCount, 1);
  assert.equal(scopedRows[2]?.resultCount, 1);
  const redacted = rows.find((row) => row.tool === 'context.search' && row.taskId === null);
  assert.ok(redacted);
  assert.equal(redacted.agentRole, 'developer');

  const schema = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const auditSchema = schema
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'context_audit_log'")
      .get() as { sql: string };
    assert.doesNotMatch(auditSchema.sql, /query|payload|source_text|result_json/iu);
  } finally {
    schema.close();
  }

  const stats = cli<{
    totalCalls: number;
    successfulCalls: number;
    resultCount: number;
    responseBytes: number;
    byTool: Record<string, { calls: number; resultCount: number }>;
  }>(fixture, 'stats', '--task-id', 'FB-003.2');
  assert.equal(stats.totalCalls, 3);
  assert.equal(stats.successfulCalls, 3);
  assert.equal(stats.resultCount, 3);
  assert.ok(stats.responseBytes > 0);
  assert.equal(stats.byTool['context.search']?.calls, 1);
  assert.equal(stats.byTool['context.get']?.calls, 1);
  assert.equal(stats.byTool['context.get_task']?.calls, 1);
});

test('MCP retrieval limits cap results, IDs, and response size', async (t) => {
  const fixture = createFixture();
  for (let index = 0; index < 7; index += 1) {
    writeFileSync(
      path.join(fixture.root, 'src', `retrieval-limit-${index}.ts`),
      `export function RetrievalLimitNeedle${index}(): string { return "${index}"; }\n`,
    );
  }
  cli(fixture, 'index');

  const connection = await connectClient(fixture, 'flowboard-limits-default');
  t.after(async () => connection.client.close());
  const defaultSearch = structuredPayload(
    await connection.client.callTool({
      name: 'context.search',
      arguments: { query: 'RetrievalLimitNeedle', limit: 50 },
    }),
  );
  assert.equal(defaultSearch.records?.length, 5);
  assert.equal(defaultSearch.returnedCount, 5);
  assert.ok((defaultSearch.totalCount ?? 0) >= 7);
  assert.ok((defaultSearch.omittedCount ?? 0) >= 2);
  assert.equal(defaultSearch.truncated, true);
  assert.equal(defaultSearch.truncationReason, 'result_limit');

  const selectedIds = defaultSearch.records?.slice(0, 4).map((record) => record.id) ?? [];
  const selected = structuredPayload(
    await connection.client.callTool({
      name: 'context.get',
      arguments: { ids: selectedIds },
    }),
  );
  assert.equal(selected.records?.length, 3);
  assert.equal(selected.returnedCount, 3);
  assert.equal(selected.omittedCount, 1);
  assert.equal(selected.truncated, true);
  assert.equal(selected.truncationReason, 'result_limit');

  for (let index = 0; index < 4; index += 1) {
    structuredPayload(
      await connection.client.callTool({
        name: 'context.save',
        arguments: {
          title: `Retrieval limit task ${index}`,
          summary: 'A bounded retrieval test task.',
          sourcePath: 'README.md',
          kind: 'task',
          key: 'FB-LIMIT',
        },
      }),
    );
  }
  const taskRecords = structuredPayload(
    await connection.client.callTool({
      name: 'context.get_task',
      arguments: { taskId: 'FB-LIMIT', includeProposed: true },
    }),
  );
  assert.equal(taskRecords.records?.length, 3);
  assert.equal(taskRecords.omittedCount, 1);
  assert.equal(taskRecords.truncated, true);
  assert.equal(taskRecords.truncationReason, 'result_limit');

  const budgetConnection = await connectClient(
    fixture,
    'flowboard-limits-budget',
    { FLOWBOARD_CONTEXT_RETRIEVAL_TOKEN_BUDGET: '256' },
  );
  t.after(async () => budgetConnection.client.close());
  const budgetResult = await budgetConnection.client.callTool({
    name: 'context.search',
    arguments: { query: 'RetrievalLimitNeedle' },
  });
  const budgetPayload = structuredPayload(budgetResult);
  const budgetText = budgetResult.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');
  assert.ok(Buffer.byteLength(budgetText, 'utf8') <= 256 * 3);
  assert.equal(budgetPayload.truncated, true);
  assert.ok(
    budgetPayload.truncationReason === 'response_budget' ||
      budgetPayload.truncationReason === 'result_limit_and_response_budget',
  );

  const configuredConnection = await connectClient(
    fixture,
    'flowboard-limits-configured',
    {
      FLOWBOARD_CONTEXT_SEARCH_LIMIT: '2',
      FLOWBOARD_CONTEXT_READ_LIMIT: '1',
      FLOWBOARD_CONTEXT_RETRIEVAL_TOKEN_BUDGET: '2000',
    },
  );
  t.after(async () => configuredConnection.client.close());
  const configuredSearch = structuredPayload(
    await configuredConnection.client.callTool({
      name: 'context.search',
      arguments: { query: 'RetrievalLimitNeedle' },
    }),
  );
  assert.equal(configuredSearch.records?.length, 2);
  const configuredGet = structuredPayload(
    await configuredConnection.client.callTool({
      name: 'context.get',
      arguments: { ids: selectedIds.slice(0, 2) },
    }),
  );
  assert.equal(configuredGet.records?.length, 1);
  assert.equal(configuredGet.truncated, true);

  await expectToolFailure(
    () =>
      connection.client.callTool({
        name: 'context.get',
        arguments: { id: '00000000-0000-4000-8000-000000000000' },
      }),
    /was not found/iu,
  );
});

test('task context is saved, updated in place, and returned by get_task', async (t) => {
  const fixture = createFixture();
  cli(fixture, 'index');
  const connection = await connectClient(fixture, 'flowboard-task-context');
  t.after(async () => connection.client.close());

  const created = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.5',
        objective: 'Reuse concise task state between FlowBoard agents.',
        affected_files: ['packages/context/src/store.ts', 'packages/context/src/server.ts'],
        architecture_decisions: ['Store one current snapshot per task_id.'],
        constraints: ['Do not store private reasoning, secrets, or full logs.'],
        completed_work: ['Defined the task context contract.'],
        verification_results: ['Relevant context tests pass.'],
        open_issues: ['Add final integration verification.'],
        source_references: ['packages/context/README.md'],
      },
    }),
  );
  assert.equal(created.taskContext?.task_id, 'FB-003.5');
  assert.equal(created.taskContext?.revision, 1);
  assert.equal(created.taskContext?.open_issues[0], 'Add final integration verification.');

  const readAfterCreate = structuredPayload(
    await connection.client.callTool({
      name: 'context.get_task',
      arguments: { task_id: 'FB-003.5' },
    }),
  );
  assert.equal(readAfterCreate.records?.length, 0);
  assert.equal(readAfterCreate.taskContext?.objective, created.taskContext?.objective);
  assert.deepEqual(
    readAfterCreate.taskContext?.affected_files,
    ['packages/context/src/store.ts', 'packages/context/src/server.ts'],
  );

  const updated = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.5',
        completed_work: [
          'Defined the task context contract.',
          'Implemented snapshot persistence and get_task reuse.',
        ],
        verification_results: ['9 relevant context tests pass.'],
        open_issues: [],
      },
    }),
  );
  assert.equal(updated.taskContext?.revision, 2);
  assert.equal(updated.taskContext?.objective, created.taskContext?.objective);
  assert.deepEqual(updated.taskContext?.open_issues, []);
  assert.equal(updated.taskContext?.completed_work.length, 2);
  assert.deepEqual(
    updated.taskContext?.source_references,
    ['packages/context/README.md'],
  );

  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        'SELECT COUNT(*) AS count, MAX(revision) AS revision FROM context_task_context WHERE task_id = ?',
      )
      .get('FB-003.5') as { count: number; revision: number };
    assert.equal(Number(row.count), 1);
    assert.equal(Number(row.revision), 2);
  } finally {
    database.close();
  }

  await expectToolFailure(
    () =>
      connection.client.callTool({
        name: 'context.update_task_context',
        arguments: {
          task_id: 'FB-003.5',
          objective: 'JWT_SECRET=must-not-be-stored',
        },
      }),
    /secret|personal data/iu,
  );
});

test('task handoff accepts api paths, checks referenced sources, and rejects unsafe paths', async (t) => {
  const fixture = createFixture();
  const apiRoot = path.join(fixture.root, 'apps', 'api');
  mkdirSync(path.join(apiRoot, 'src', 'modules', 'auth', 'guards'), { recursive: true });
  mkdirSync(path.join(apiRoot, 'prisma'), { recursive: true });
  writeFileSync(
    path.join(apiRoot, 'src', 'modules', 'auth', 'auth.module.ts'),
    'export class AuthModule {}\n',
  );
  const guardPath = path.join(apiRoot, 'src', 'modules', 'auth', 'guards', 'access-token.guard.ts');
  writeFileSync(guardPath, 'export class AccessTokenGuard {}\n');
  writeFileSync(path.join(apiRoot, 'prisma', 'schema.prisma'), 'model User { id String @id }\n');
  git(fixture.root, ['add', 'apps/api']);
  git(fixture.root, ['commit', '-qm', 'add api sources']);
  cli(fixture, 'index');

  const connection = await connectClient(fixture, 'flowboard-api-paths');
  t.after(async () => connection.client.close());
  const sourceReferences = [
    'apps/api/src/modules/auth/auth.module.ts',
    'apps/api/src/modules/auth/guards/access-token.guard.ts',
    'apps/api/prisma/schema.prisma',
  ];
  const saved = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.15',
        objective: 'Make MCP context handoffs reliable.',
        affected_files: sourceReferences,
        source_references: sourceReferences,
      },
    }),
  );
  assert.equal(saved.taskContext?.revision, 1);

  const fresh = structuredPayload(
    await connection.client.callTool({
      name: 'context.get_task',
      arguments: { task_id: 'FB-003.15' },
    }),
  );
  assert.equal(fresh.source_references_freshness?.checked, 3);
  assert.equal(fresh.source_references_freshness?.fresh, 3);
  assert.equal(fresh.source_references_freshness?.stale, 0);

  writeFileSync(guardPath, 'export class AccessTokenGuardChanged {}\n');
  const stale = structuredPayload(
    await connection.client.callTool({
      name: 'context.get_task',
      arguments: { task_id: 'FB-003.15' },
    }),
  );
  assert.equal(stale.source_references_freshness?.checked, 3);
  assert.equal(stale.source_references_freshness?.stale, 1);
  assert.deepEqual(
    stale.source_references_freshness?.staleIds,
    ['apps/api/src/modules/auth/guards/access-token.guard.ts'],
  );

  for (const unsafePath of ['../../etc/passwd', '/etc/passwd', 'apps/api/../secret.ts', 'apps/api/\u0000.ts']) {
    await expectToolFailure(
      () => connection.client.callTool({
        name: 'context.update_task_context',
        arguments: {
          task_id: 'FB-003.15',
          source_references: [unsafePath],
        },
      }),
      /path|traversal|safe|secret/iu,
    );
  }
  const failed = databaseAuditRows(fixture).filter((row) => row.taskId === 'FB-003.15' && row.success === 0);
  assert.equal(failed.length, 4);
  assert.ok(failed.every((row) => row.errorCode === 'unsafe_path'));
});

test('task handoff accepts substantive notes, is idempotent, and audits revisions', async (t) => {
  const fixture = createFixture();
  const connection = await connectClient(fixture, 'flowboard-task-handoff');
  t.after(async () => connection.client.close());

  const initial = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.9',
        agent_role: 'developer',
        expected_revision: 0,
        objective: 'Optimize task context handoffs between agents.',
        completed_work: ['Keep the important handoff detail.', 'Keep the important handoff detail.'],
      },
    }),
  );
  assert.equal(initial.taskContext?.revision, 1);
  assert.deepEqual(initial.taskContext?.completed_work, ['Keep the important handoff detail.']);

  const repeated = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.9',
        agent_role: 'developer',
        expected_revision: 1,
        objective: 'Optimize task context handoffs between agents.',
        completed_work: ['Keep the important handoff detail.'],
      },
    }),
  );
  assert.equal(repeated.taskContext?.revision, 1);

  const longNote = `Important implementation detail: ${'preserve this handoff detail. '.repeat(20)}`;
  assert.ok(longNote.length > 240);
  const substantive = structuredPayload(
    await connection.client.callTool({
      name: 'context.update_task_context',
      arguments: {
        task_id: 'FB-003.9',
        agent_role: 'developer',
        expected_revision: 1,
        architecture_decisions: [longNote],
      },
    }),
  );
  assert.equal(substantive.taskContext?.revision, 2);
  assert.equal(substantive.taskContext?.architecture_decisions[0], longNote.trim());

  await expectToolFailure(
    () =>
      connection.client.callTool({
        name: 'context.update_task_context',
        arguments: {
          task_id: 'FB-003.9',
          agent_role: 'reviewer',
          expected_revision: 1,
          open_issues: ['The reviewer has an outdated snapshot.'],
        },
      }),
    /Revision conflict.*expected 1.*current 2/iu,
  );
  await expectToolFailure(
    () =>
      connection.client.callTool({
        name: 'context.update_task_context',
        arguments: {
          task_id: 'FB-003.9',
          agent_role: 'developer',
          expected_revision: 2,
          constraints: ['x'.repeat(1201)],
        },
      }),
    /constraints.*1200/iu,
  );

  const rows = databaseAuditRows(fixture).filter((row) => row.taskId === 'FB-003.9');
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.success), [1, 1, 1, 0, 0]);
  assert.deepEqual(rows.map((row) => row.revisionBefore), [0, 1, 1, 2, 2]);
  assert.deepEqual(rows.map((row) => row.revisionAfter), [1, 1, 2, null, null]);
  assert.ok(rows.every((row) => row.requestBytes > 0));
  assert.ok(rows.every((row) => row.durationMs >= 0));
  assert.ok(rows.every((row) => row.responseBytes >= 0));

  const stats = cli<{
    failedCalls: number;
    requestBytes: number;
    byTool: Record<string, { calls: number; failedCalls: number; requestBytes: number }>;
  }>(fixture, 'stats', '--tool', 'context.update_task_context', '--task-id', 'FB-003.9');
  assert.equal(stats.failedCalls, 2);
  assert.equal(stats.requestBytes > 0, true);
  assert.equal(stats.byTool['context.update_task_context']?.calls, 5);
  assert.equal(stats.byTool['context.update_task_context']?.failedCalls, 2);
});
