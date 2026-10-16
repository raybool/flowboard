import { buildCompactHandoffText } from './handoff.js';
import { buildExecutionPlan } from './plan.js';
import { correctionLimitsFor, executionStepsFor, recommendedChecksFor, rolesForClassification } from './policy.js';
import type {
  Classification,
  ExecutionPlan,
  ClassificationLevel,
  TaskInput,
} from './types.js';
import type { ExecutionPlanOptions } from './plan.js';

export interface ResolvedExecutionPlan {
  plan: ExecutionPlan;
  fallbackReason?: string;
}

function safeFallbackPlan(task: TaskInput, reason: string): ExecutionPlan {
  const level: ClassificationLevel = 'CRITICAL';
  const classification: Classification = {
    level,
    signals: [],
    reasons: [`plan-unavailable:${reason}`, 'safe-fallback:CRITICAL'],
    escalated: true,
  };

  return {
    taskId: task.taskId,
    dryRun: true,
    classification,
    primaryRole: 'developer',
    delegatedRoles: rolesForClassification(level),
    roles: rolesForClassification(level),
    steps: executionStepsFor(level),
    correctionLimits: correctionLimitsFor(level),
    recommendedChecks: recommendedChecksFor(level),
    context: {
      classification: level,
      mode: 'targeted-source',
      strategy: 'targeted-source',
      source: 'repository',
      reason: 'mcp-unavailable',
    },
    handoff: {
      mode: 'compact-text',
      strategy: 'compact-text',
      source: 'fallback',
      reason: 'handoff-failed',
      text: buildCompactHandoffText(task),
    },
  };
}

/**
 * Coordinator entrypoint. Policy failures fail closed into a CRITICAL plan.
 * It never starts agents or mutates repository files.
 */
export function resolveExecutionPlan(
  task: TaskInput,
  options: ExecutionPlanOptions = {},
): ResolvedExecutionPlan {
  try {
    return { plan: buildExecutionPlan(task, options) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { plan: safeFallbackPlan(task, reason), fallbackReason: reason };
  }
}
