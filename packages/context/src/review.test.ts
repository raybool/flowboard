import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { DatabaseSync } from 'node:sqlite';
import {
  containsSensitiveMetadata,
  containsSensitivePathMetadata,
  containsSensitiveText,
  ContextStore,
  type SourceSnapshot,
} from './store.js';

const source: SourceSnapshot = {
  path: 'README.md',
  commit: 'test-commit',
  hash: 'test-hash',
  modifiedAt: '2026-01-01T00:00:00.000Z',
};

test('sensitive tokens are rejected from summaries, keys and indexed metadata', () => {
  assert.equal(containsSensitiveText(`ghp_${'A'.repeat(36)}`), true);
  assert.equal(containsSensitiveText('AKIA' + 'A'.repeat(16)), true);
  assert.equal(containsSensitiveText('JWT_SECRET=supersecretvalue'), true);
  assert.equal(
    containsSensitiveText("secret: config.get('JWT_ACCESS_SECRET')"),
    false,
  );
  assert.equal(
    containsSensitiveText('const authorization = request.headers.authorization;'),
    false,
  );
  assert.equal(
    containsSensitiveText('const token = authorization.slice(7);'),
    false,
  );
  assert.equal(containsSensitiveMetadata('src/secrets.ts'), true);
  assert.equal(containsSensitivePathMetadata('src/access-token.guard.ts'), false);
  assert.equal(containsSensitivePathMetadata('src/secrets.ts'), true);

  const store = new ContextStore(':memory:');
  try {
    assert.throws(() => store.createProposal({
      title: 'Reference', summary: 'Safe note', kind: 'fact',
      key: `ghp_${'A'.repeat(36)}`, source,
    }), /secret|personal data/u);
    assert.throws(() => store.createProposal({
      title: 'Architecture', summary: 'JWT_SECRET=supersecretvalue',
      kind: 'architecture', source,
    }), /secret|personal data/u);
    assert.throws(() => store.upsertIndexedSource({
      kind: 'source', title: 'src/secrets.ts', summary: 'metadata',
      symbols: [], imports: [], source: { ...source, path: 'src/secrets.ts' },
    }), /sensitive/u);
  } finally {
    store.close();
  }
});

test('typed context and replacement confirmation keep one current decision', () => {
  const store = new ContextStore(':memory:');
  try {
    const root = store.createProposal({
      title: 'API contract', summary: 'Contract version one.',
      kind: 'api_contract', key: 'FB-008:api', source,
    });
    assert.equal(store.confirm(root.id, source).kind, 'api_contract');
    const first = store.proposeUpdate(root.id, { summary: 'Contract version two.', source });
    const second = store.proposeUpdate(root.id, { summary: 'Contract version three.', source });
    assert.equal(store.confirm(first.id, source).status, 'confirmed');
    assert.throws(() => store.confirm(second.id, source), /already superseded/u);
    assert.equal(store.get(root.id)?.status, 'invalidated');
    assert.equal(store.get(second.id)?.status, 'proposed');
    assert.equal(store.search('Contract', { kind: 'api_contract' }).length, 1);
    const module = store.createProposal({
      title: 'Module map', summary: 'One local module.', kind: 'module', source,
    });
    assert.equal(store.confirm(module.id, source).kind, 'module');
    const derived = store.upsertIndexedSource({
      kind: 'source', title: 'README.md', summary: 'Markdown file.',
      symbols: [], imports: [], source,
    }).record;
    assert.equal(store.resetDerived(), 1);
    assert.equal(store.get(derived.id), null);
    assert.equal(store.get(module.id)?.status, 'confirmed');
  } finally {
    store.close();
  }
});

test('indexed source upsert is idempotent across provenance and metadata ordering', () => {
  const store = new ContextStore(':memory:');
  try {
    const first = store.upsertIndexedSource({
      kind: 'source',
      title: 'src/index.ts',
      summary: 'TypeScript file; 2 indexed symbols; 1 indexed imports.',
      symbols: ['Beta', 'Alpha', 'Alpha'],
      imports: ['./store.js'],
      source: { ...source, path: 'src/index.ts' },
    });
    const before = first.record;
    const second = store.upsertIndexedSource({
      kind: 'source',
      title: 'src/index.ts',
      summary: 'TypeScript file; 2 indexed symbols; 1 indexed imports.',
      symbols: ['Alpha', 'Beta'],
      imports: ['./store.js'],
      source: {
        ...source,
        path: 'src/index.ts',
        commit: 'new-head-with-same-content',
        modifiedAt: '2026-02-01T00:00:00.000Z',
      },
    });

    assert.equal(second.created, false);
    assert.equal(second.changed, false);
    assert.equal(second.record.id, before.id);
    assert.equal(second.record.updatedAt, before.updatedAt);
    assert.equal(second.record.source.commit, 'new-head-with-same-content');
    assert.deepEqual(second.record.symbols, ['Alpha', 'Beta']);
  } finally {
    store.close();
  }
});

test('FTS keeps strict matches primary, falls back for phrases, and ranks paths and symbols', () => {
  const store = new ContextStore(':memory:');
  const indexed = (filePath: string, symbols: string[], summary: string) => {
    store.upsertIndexedSource({
      kind: 'source',
      title: filePath,
      summary,
      symbols,
      imports: [],
      source: { ...source, path: filePath },
    });
  };

  try {
    indexed('src/auth/jwt.ts', ['JwtStrategy'], 'JWT authentication source.');
    indexed(
      'src/auth/access-token.guard.ts',
      ['AccessTokenGuard'],
      'Authorization guard source.',
    );
    indexed('src/auth/auth.module.ts', ['AuthModule'], 'Authentication module source.');
    indexed(
      'src/auth/refresh-token.service.ts',
      ['RefreshTokenService'],
      'Refresh token lifecycle source.',
    );
    indexed(
      'src/auth/session-rotation.ts',
      ['SessionRotation'],
      'Session lifecycle rotation source.',
    );
    indexed(
      'docs/auth-notes.md',
      [],
      'JWT AuthModule guard reference for documentation.',
    );

    assert.equal(store.search('JWT')[0]?.source.path, 'src/auth/jwt.ts');
    assert.equal(
      store.search('guard')[0]?.source.path,
      'src/auth/access-token.guard.ts',
    );
    assert.equal(store.search('AuthModule')[0]?.source.path, 'src/auth/auth.module.ts');

    const strictRefreshToken = store.search('refresh token');
    assert.ok(strictRefreshToken.length >= 1);
    assert.ok(
      strictRefreshToken.every(
        (record) => record.source.path !== 'src/auth/session-rotation.ts',
      ),
    );

    const fallback = store.search('refresh token rotation');
    assert.equal(fallback[0]?.source.path, 'src/auth/refresh-token.service.ts');
    assert.ok(fallback.some((record) => record.source.path === 'src/auth/session-rotation.ts'));

    const firstOrder = store.search('guard').map((record) => record.id);
    const secondOrder = store.search('guard').map((record) => record.id);
    assert.deepEqual(secondOrder, firstOrder);
  } finally {
    store.close();
  }
});

test('MCP command builds missing dist before starting on a fresh package copy', async () => {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'flowboard-context-clean-'));
  const copiedPackage = path.join(checkout, 'context');
  cpSync(path.join(packageRoot, 'src'), path.join(copiedPackage, 'src'), { recursive: true });
  copyFileSync(path.join(packageRoot, 'package.json'), path.join(copiedPackage, 'package.json'));
  copyFileSync(path.join(packageRoot, 'tsconfig.json'), path.join(copiedPackage, 'tsconfig.json'));
  symlinkSync(path.join(packageRoot, 'node_modules'), path.join(copiedPackage, 'node_modules'));

  const client = new Client({ name: 'clean-startup-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['mcp'],
    cwd: copiedPackage,
    env: {
      ...process.env,
      FLOWBOARD_CONTEXT_ROOT: path.resolve(packageRoot, '../..'),
      FLOWBOARD_CONTEXT_DB: path.join(checkout, 'context.sqlite'),
    } as Record<string, string>,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 7);
    const database = new DatabaseSync(path.join(checkout, 'context.sqlite'), { readOnly: true });
    try {
      const indexed = database
        .prepare('SELECT COUNT(*) AS count FROM context_index_state')
        .get() as { count: number };
      assert.ok(Number(indexed.count) > 0, 'MCP startup should perform incremental indexing');
    } finally {
      database.close();
    }
  } finally {
    await client.close();
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('schema migration preserves existing manual decisions', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'flowboard-context-migration-'));
  const databasePath = path.join(directory, 'context.sqlite');
  const legacy = new DatabaseSync(databasePath);
  try {
    legacy.exec(`
      CREATE TABLE context_records (
        id TEXT PRIMARY KEY, record_key TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('source','fact','decision','task','assumption')),
        title TEXT NOT NULL, summary TEXT NOT NULL,
        symbols_json TEXT NOT NULL DEFAULT '[]', imports_json TEXT NOT NULL DEFAULT '[]',
        source_kind TEXT NOT NULL, source_path TEXT NOT NULL,
        source_commit TEXT NOT NULL, source_hash TEXT NOT NULL,
        source_modified_at TEXT NOT NULL, status TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0, supersedes_id TEXT,
        invalidation_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        confirmed_at TEXT, invalidated_at TEXT
      );
      CREATE TABLE context_index_state (
        source_path TEXT PRIMARY KEY, source_hash TEXT NOT NULL,
        source_commit TEXT NOT NULL, source_modified_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL, record_id TEXT NOT NULL
      );
      INSERT INTO context_records (
        id, record_key, kind, title, summary, source_kind, source_path,
        source_commit, source_hash, source_modified_at, status, created_at, updated_at
      ) VALUES (
        'legacy-decision', 'FB-008', 'decision', 'Original layout', 'Keep this decision.',
        'manual', 'README.md', 'abc', 'hash', '2026-01-01T00:00:00Z',
        'confirmed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      );
    `);
  } finally {
    legacy.close();
  }
  try {
    const migrated = new ContextStore(databasePath);
    try {
      assert.equal(migrated.get('legacy-decision')?.summary, 'Keep this decision.');
      assert.equal(migrated.search('Original', { kind: 'decision' })[0]?.id, 'legacy-decision');
      const newKind = migrated.createProposal({
        title: 'Architecture map', summary: 'Module connections.',
        kind: 'architecture', source,
      });
      assert.equal(newKind.kind, 'architecture');
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
