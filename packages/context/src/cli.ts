#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { GitContextIndexer, resolveGitRoot } from './indexer.js';
import { ContextStore, type AuditToolName } from './store.js';

interface CliContext {
  root: string;
  store: ContextStore;
  indexer: GitContextIndexer;
}

function resolveRoot(): string {
  return path.resolve(process.env.FLOWBOARD_CONTEXT_ROOT ?? process.cwd());
}

function createCliContext(): CliContext {
  const root = resolveGitRoot(resolveRoot());
  const databasePath = process.env.FLOWBOARD_CONTEXT_DB
    ? path.resolve(process.env.FLOWBOARD_CONTEXT_DB)
    : path.join(root, '.flowboard-context', 'context.sqlite');
  const store = new ContextStore(databasePath);
  return { root, store, indexer: new GitContextIndexer(store, root) };
}

function writeJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return `Usage: flowboard-context <command>

Commands:
  index                 Build or refresh the complete derived Git index
  update                Incrementally update changed tracked sources
  search <query>        Search confirmed context (--all, --limit <n>)
  status                Show database and index status
  stats                 Show MCP read audit statistics
  get <id>              Show one record
  confirm <id>          Confirm a proposal after validating its source
  reset [--yes]         Rebuild derived Git records; keep manual records
  help                  Show this help`;
}

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) {
    return equals.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function confirmReset(args: string[]): Promise<boolean> {
  if (args.includes('--yes')) {
    return true;
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('reset requires an interactive confirmation or --yes.');
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      'Rebuild derived context records? Manual records are preserved. Type "reset" to continue: ',
    );
    return answer.trim().toLowerCase() === 'reset';
  } finally {
    prompt.close();
  }
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  const [command = 'help', ...rest] = args;
  if (command === 'help' || command === '--help' || command === '-h') {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const context = createCliContext();
  try {
    switch (command) {
      case 'index': {
        writeJson({ command, ...context.indexer.index({ full: true }) });
        return 0;
      }
      case 'update': {
        writeJson({ command, ...context.indexer.index() });
        return 0;
      }
      case 'search': {
        const queryParts: string[] = [];
        for (let index = 0; index < rest.length; index += 1) {
          const argument = rest[index];
          if (argument === '--all' || argument?.startsWith('--limit=')) {
            continue;
          }
          if (argument === '--limit') {
            index += 1;
            continue;
          }
          if (argument) {
            queryParts.push(argument);
          }
        }
        const query = queryParts.join(' ');
        const rawLimit = optionValue(rest, '--limit');
        const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
        if (!query.trim()) {
          throw new Error('search requires a query.');
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
          throw new Error('--limit must be an integer between 1 and 50.');
        }
        const candidates = context.store.search(query, {
          includeProposed: rest.includes('--all'),
          limit: Math.min((limit ?? 10) * 3, 50),
          includeStale: true,
        });
        const freshness = context.indexer.refreshStaleness(candidates);
        const records = context.store.search(query, {
          includeProposed: rest.includes('--all'),
          limit,
        });
        writeJson({ command, query, freshness, count: records.length, records });
        return 0;
      }
      case 'status': {
        const freshness = context.indexer.refreshStaleness();
        writeJson({
          command,
          root: context.indexer.root,
          freshness,
          ...context.store.status(),
        });
        return 0;
      }
      case 'stats': {
        const tool = optionValue(rest, '--tool');
        const validTools: AuditToolName[] = [
          'context.search',
          'context.get',
          'context.get_task',
          'context.update_task_context',
        ];
        if (tool !== undefined && !validTools.includes(tool as AuditToolName)) {
          throw new Error(`--tool must be one of: ${validTools.join(', ')}`);
        }
        writeJson({
          command,
          ...context.store.auditStats({
            tool: tool as AuditToolName | undefined,
            taskId: optionValue(rest, '--task-id'),
            agentRole: optionValue(rest, '--agent-role'),
            since: optionValue(rest, '--since'),
            until: optionValue(rest, '--until'),
          }),
        });
        return 0;
      }
      case 'get': {
        const id = rest[0];
        if (!id) {
          throw new Error('get requires a record ID.');
        }
        let record = context.store.get(id);
        if (!record) {
          throw new Error(`Context record ${id} was not found.`);
        }
        const freshness = context.indexer.refreshStaleness([record]);
        record = context.store.get(id);
        if (!record) {
          throw new Error(`Context record ${id} was not found.`);
        }
        writeJson({ command, freshness, record });
        return 0;
      }
      case 'confirm': {
        const id = rest[0];
        if (!id) {
          throw new Error('confirm requires a record ID.');
        }
        const proposal = context.store.get(id);
        if (!proposal) {
          throw new Error(`Context record ${id} was not found.`);
        }
        const freshness = context.indexer.refreshStaleness([proposal]);
        const source = context.indexer.snapshotSource(proposal.source.path);
        const record = context.store.confirm(id, source);
        writeJson({ command, freshness, record });
        return 0;
      }
      case 'reset': {
        if (!(await confirmReset(rest))) {
          writeJson({ command, reset: false, reason: 'confirmation declined' });
          return 1;
        }
        const removed = context.store.resetDerived();
        const indexed = context.indexer.index({ full: true });
        writeJson({ command, reset: true, removed, indexed });
        return 0;
      }
      default:
        throw new Error(`Unknown command: ${command}\n${usage()}`);
    }
  } finally {
    context.store.close();
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  runCli().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
