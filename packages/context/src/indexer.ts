import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  containsSensitiveText,
  containsSensitiveMetadata,
  containsSensitivePathMetadata,
  ContextStore,
  type SourceSnapshot,
} from './store.js';

export interface IndexResult {
  root: string;
  commit: string;
  scanned: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalidated: number;
  indexedAt: string;
}

export interface StalenessResult {
  commit: string;
  checked: number;
  stale: number;
  changed: number;
  staleIds: string[];
}

interface StalenessCandidate {
  id: string;
  source: Pick<SourceSnapshot, 'path' | 'hash'>;
}

const ALLOWED_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.md',
  '.mjs',
  '.prisma',
  '.scss',
  '.sh',
  '.sql',
  '.toml',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const EXCLUDED_SEGMENTS = new Set([
  '.codex',
  '.git',
  '.flowboard-context',
  '.pnpm-store',
  '.yarn',
  '.cache',
  '.parcel-cache',
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'generated',
  'build',
  'node_modules',
  'out',
]);
const EXCLUDED_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ITEMS = 24;

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveGitRoot(root: string): string {
  return realpathSync(git(path.resolve(root), ['rev-parse', '--show-toplevel']));
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function isSafeRelativePath(value: string): boolean {
  const normalized = path.posix.normalize(value);
  if (
    value.length === 0 ||
    path.isAbsolute(value) ||
    normalized !== value ||
    value.includes('\0') ||
    containsSensitivePathMetadata(value) ||
    value.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    return false;
  }
  const segments = value.split('/');
  const filename = segments.at(-1)?.toLowerCase() ?? '';
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()))) {
    return false;
  }
  if (
    EXCLUDED_FILENAMES.has(filename) ||
    filename === '.env' ||
    filename.startsWith('.env.') ||
    /(?:^|[._-])(?:credentials?|secrets?)(?:[._-]|$)/iu.test(filename) ||
    /\.(?:crt|der|key|p12|pem|pfx)$/iu.test(filename)
  ) {
    return false;
  }
  return ALLOWED_EXTENSIONS.has(path.extname(filename));
}

function unique(items: Iterable<string>): string[] {
  return [...new Set(items)].slice(0, MAX_ITEMS);
}

function extractSymbols(source: string, extension: string): string[] {
  const symbols: string[] = [];
  const patterns: RegExp[] = [];
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    patterns.push(
      /\bexport\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gu,
    );
  } else if (extension === '.prisma') {
    patterns.push(/\b(?:model|enum|type)\s+([A-Za-z_][\w]*)/gu);
  } else if (extension === '.sql') {
    patterns.push(/\bCREATE\s+(?:TABLE|VIEW|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][\w.]*)/giu);
  }
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        symbols.push(match[1]);
      }
    }
  }
  return unique(symbols);
}

function extractImports(source: string, extension: string): string[] {
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    return [];
  }
  const imports: string[] = [];
  const patterns = [
    /\bimport(?:[\s\S]{0,300}?\bfrom\s*)?["']([^"'\r\n]+)["']/gu,
    /\brequire\(\s*["']([^"'\r\n]+)["']\s*\)/gu,
    /\bimport\(\s*["']([^"'\r\n]+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (value && /^[A-Za-z0-9@_./:-]{1,160}$/u.test(value)) {
        imports.push(value);
      }
    }
  }
  return unique(imports);
}

function languageLabel(extension: string): string {
  const labels: Record<string, string> = {
    '.cjs': 'JavaScript',
    '.css': 'CSS',
    '.html': 'HTML',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript React',
    '.json': 'JSON',
    '.md': 'Markdown',
    '.mjs': 'JavaScript',
    '.prisma': 'Prisma schema',
    '.scss': 'SCSS',
    '.sh': 'shell',
    '.sql': 'SQL',
    '.toml': 'TOML',
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript React',
    '.yaml': 'YAML',
    '.yml': 'YAML',
  };
  return labels[extension] ?? 'source';
}

export class GitContextIndexer {
  readonly root: string;

  constructor(
    private readonly store: ContextStore,
    root: string,
  ) {
    this.root = resolveGitRoot(root);
  }

  currentCommit(): string {
    return git(this.root, ['rev-parse', 'HEAD']);
  }

  trackedPaths(): string[] {
    const output = execFileSync(
      'git',
      [
        '-C',
        this.root,
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return output
      .split('\0')
      .filter(Boolean)
      .map(toPosixPath);
  }

  private changedPaths(previousCommit: string | null, currentCommit: string): Set<string> | null {
    const changed = new Set<string>();
    const collect = (args: string[]): boolean => {
      try {
        const output = git(this.root, args);
        for (const value of output.split('\0').filter(Boolean)) {
          changed.add(toPosixPath(value));
        }
        return true;
      } catch {
        return false;
      }
    };

    if (previousCommit && previousCommit !== currentCommit) {
      if (!collect(['diff', '--name-only', '--no-renames', '-z', previousCommit, currentCommit, '--'])) {
        return null;
      }
    }
    if (!collect(['diff', '--name-only', '--no-renames', '-z', '--'])) {
      return null;
    }
    if (!collect(['diff', '--cached', '--name-only', '--no-renames', '-z', '--'])) {
      return null;
    }
    if (!collect(['ls-files', '-z', '--others', '--exclude-standard'])) {
      return null;
    }
    return changed;
  }

  snapshotSource(relativePath: string): SourceSnapshot {
    return this.readSourceAtCommit(relativePath, this.currentCommit()).snapshot;
  }

  private snapshotSourceAtCommit(
    relativePath: string,
    commit: string,
  ): SourceSnapshot {
    return this.readSourceAtCommit(relativePath, commit).snapshot;
  }

  private readSourceAtCommit(
    relativePath: string,
    commit: string,
  ): { snapshot: SourceSnapshot; content: string } {
    const normalized = toPosixPath(relativePath.trim());
    if (!isSafeRelativePath(normalized)) {
      throw new Error(`Source path is not eligible for context storage: ${relativePath}`);
    }
    const absolutePath = path.resolve(this.root, normalized);
    const relativeCheck = path.relative(this.root, absolutePath);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
      throw new Error('Source path escapes the repository root.');
    }
    const stats = lstatSync(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error('Source must be a regular, non-symlink file.');
    }
    if (stats.size > MAX_SOURCE_BYTES) {
      throw new Error(`Source is larger than ${MAX_SOURCE_BYTES} bytes.`);
    }
    const realSourcePath = realpathSync(absolutePath);
    const realRelative = path.relative(this.root, realSourcePath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      throw new Error('Source resolves outside the repository root.');
    }
    const expected = lstatSync(realSourcePath);
    const fd = openSync(realSourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let modifiedAt: string;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_SOURCE_BYTES ||
          opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new Error('Source changed while being opened.');
      }
      bytes = readFileSync(fd);
      const afterRead = fstatSync(fd);
      if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
        throw new Error('Source changed while being read.');
      }
      modifiedAt = afterRead.mtime.toISOString();
    } finally {
      closeSync(fd);
    }
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (source.includes('\u0000') || containsSensitiveText(source)) {
      throw new Error('Source may contain a secret, personal data, or binary data.');
    }
    return {
      snapshot: {
        path: normalized,
        commit,
        hash: createHash('sha256').update(bytes).digest('hex'),
        modifiedAt,
      },
      content: source,
    };
  }

  refreshStaleness(
    candidates?: readonly StalenessCandidate[],
    persist = true,
  ): StalenessResult {
    const commit = this.currentCommit();
    const references = candidates
      ? candidates.map((candidate) => ({
          id: candidate.id,
          path: candidate.source.path,
          commit,
          hash: candidate.source.hash,
        }))
      : this.store.activeSourceReferences();
    const snapshots = new Map<string, SourceSnapshot | null>();
    const staleness = new Map<string, boolean>();
    let stale = 0;
    const staleIds: string[] = [];
    for (const reference of references) {
      let snapshot = snapshots.get(reference.path);
      if (snapshot === undefined) {
        try {
          snapshot = this.snapshotSourceAtCommit(reference.path, commit);
        } catch {
          snapshot = null;
        }
        snapshots.set(reference.path, snapshot);
      }
      const isStale = snapshot === null || snapshot.hash !== reference.hash;
      staleness.set(reference.id, isStale);
      if (isStale) {
        stale += 1;
        staleIds.push(reference.id);
      }
    }
    return {
      commit,
      checked: references.length,
      stale,
      changed: persist ? this.store.setStaleness(staleness) : 0,
      staleIds,
    };
  }

  index(options: { full?: boolean } = {}): IndexResult {
    const commit = this.currentCommit();
    const indexedAt = new Date().toISOString();
    const previousHashes = this.store.indexedSourceHashes();
    const previousCommit = this.store.lastIndexedCommit();
    const tracked = this.trackedPaths();
    const eligiblePaths = tracked.filter((sourcePath) => isSafeRelativePath(sourcePath));
    const currentPaths = new Set(eligiblePaths);
    const candidates = options.full || !previousCommit
      ? new Set(eligiblePaths)
      : this.changedPaths(previousCommit, commit) ?? new Set(eligiblePaths);
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const sourcePath of tracked) {
      if (!isSafeRelativePath(sourcePath)) {
        skipped += 1;
        continue;
      }
      if (!candidates.has(sourcePath)) {
        unchanged += 1;
        continue;
      }
      let snapshot: SourceSnapshot;
      let source: string;
      try {
        const inspected = this.readSourceAtCommit(sourcePath, commit);
        snapshot = inspected.snapshot;
        if (!options.full && previousHashes.get(sourcePath) === snapshot.hash) {
          currentPaths.add(sourcePath);
          unchanged += 1;
          continue;
        }
        source = inspected.content;
      } catch {
        currentPaths.delete(sourcePath);
        skipped += 1;
        continue;
      }
      const extension = path.extname(sourcePath).toLowerCase();
      const symbols = extractSymbols(source, extension);
      const imports = extractImports(source, extension);
      if (symbols.some(containsSensitiveMetadata) || imports.some(containsSensitivePathMetadata)) {
        currentPaths.delete(sourcePath);
        skipped += 1;
        continue;
      }
      const summary = `${languageLabel(extension)} file; ${symbols.length} indexed symbols; ${imports.length} indexed imports.`;
      const result = this.store.upsertIndexedSource({
        kind: 'source',
        title: sourcePath,
        summary,
        symbols,
        imports,
        source: snapshot,
      });
      if (result.created) {
        created += 1;
      } else if (result.changed) {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
    const invalidated = this.store.invalidateMissingIndexedSources(currentPaths);
    if (
      previousCommit !== commit ||
      created > 0 ||
      updated > 0 ||
      invalidated > 0
    ) {
      this.store.setIndexMetadata(commit, indexedAt);
    }
    return {
      root: this.root,
      commit,
      scanned: candidates.size,
      created,
      updated,
      unchanged,
      skipped,
      invalidated,
      indexedAt,
    };
  }
}
