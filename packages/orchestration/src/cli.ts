#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveExecutionPlan } from './coordinator.js';
import type { ExecutionPlanOptions } from './plan.js';
import type { ExecutionPlan, TaskInput } from './types.js';

interface CliOptions extends ExecutionPlanOptions {
  task: string;
  taskId: string;
  json: boolean;
}

function usage(): string {
  return `Usage: orchestration:plan --task <title> [options]

Options:
  --task <title>          Task title used for deterministic classification
  --task-id <id>          Optional task ID (default: dry-run)
  --json                  Print the execution plan as JSON
  --mcp-unavailable       Use targeted-source context fallback
  --handoff-failed        Use compact-text handoff fallback
  --help                  Show this help`;
}

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find((argument) => argument.startsWith(`${name}=`));
  if (equals) {
    return equals.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes('--help') || args.includes('-h')) {
    throw new Error(usage());
  }
  const task = optionValue(args, '--task')?.trim();
  if (!task) {
    throw new Error(`--task is required.\n${usage()}`);
  }
  const taskId = optionValue(args, '--task-id')?.trim() || 'dry-run';
  if (taskId.length === 0) {
    throw new Error('--task-id must not be empty.');
  }
  const json = args.includes('--json') || args.includes('--format=json');
  return {
    task,
    taskId,
    json,
    mcpAvailable: args.includes('--mcp-unavailable') ? false : undefined,
    handoffSucceeded: args.includes('--handoff-failed') ? false : undefined,
  };
}

function planInput(options: CliOptions): TaskInput {
  return {
    taskId: options.taskId,
    title: options.task,
  };
}

function writeHumanPlan(plan: ExecutionPlan, fallbackReason?: string): void {
  const steps = plan.steps.length === 0
    ? 'none'
    : plan.steps.map((step) => `${step.order}. ${step.role}`).join(', ');
  const delegated = plan.delegatedRoles.length === 0
    ? 'none'
    : plan.delegatedRoles.join(', ');
  const handoff = plan.handoff.text
    ? `${plan.handoff.mode} (${plan.handoff.reason}): ${plan.handoff.text}`
    : `${plan.handoff.mode} (${plan.handoff.reason})`;

  process.stdout.write(`Execution plan (dry-run)\n`);
  process.stdout.write(`Task: ${plan.taskId}\n`);
  process.stdout.write(`Mode: ${plan.classification.level}\n`);
  process.stdout.write(`Reason: ${plan.classification.reasons.join(', ')}\n`);
  process.stdout.write(`Primary role: ${plan.primaryRole}\n`);
  process.stdout.write(`Delegated roles: ${delegated}\n`);
  process.stdout.write(`Stages: ${steps}\n`);
  process.stdout.write(`Handoff: ${handoff}\n`);
  process.stdout.write(`Context: ${plan.context.mode} (${plan.context.source})\n`);
  process.stdout.write(`Recommended checks: ${plan.recommendedChecks.join(', ')}\n`);
  if (fallbackReason) {
    process.stdout.write(`Warning: execution plan unavailable; safe fallback applied: ${fallbackReason}\n`);
  }
  process.stdout.write('No subagents started; repository was not modified by the plan.\n');
}

export function runCli(args = process.argv.slice(2)): number {
  try {
    const options = parseArgs(args);
    const resolved = resolveExecutionPlan(planInput(options), {
      mcpAvailable: options.mcpAvailable,
      handoffSucceeded: options.handoffSucceeded,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(
        resolved.fallbackReason
          ? { ...resolved.plan, warning: `safe-fallback:${resolved.fallbackReason}` }
          : resolved.plan,
        null,
        2,
      )}\n`);
    } else {
      writeHumanPlan(resolved.plan, resolved.fallbackReason);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === usage()) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  process.exitCode = runCli();
}
