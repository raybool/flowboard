import { classifyTask } from './classifier.js';
import { createContextStrategy } from './context.js';
import { createHandoffStrategy, type HandoffOptions } from './handoff.js';
import {
  correctionLimitsFor,
  executionStepsFor,
  recommendedChecksFor,
  rolesForClassification,
} from './policy.js';
import type { ClassificationLevel, ExecutionPlan, TaskInput } from './types.js';

export interface ExecutionPlanOptions extends HandoffOptions {
  initialClassification?: ClassificationLevel;
}

export function buildExecutionPlan(
  task: TaskInput,
  options: ExecutionPlanOptions = {},
): ExecutionPlan {
  const classification = classifyTask({
    ...task,
    initialClassification: options.initialClassification ?? task.initialClassification,
  });
  const handoffOptions: HandoffOptions = {
    mcpAvailable: options.mcpAvailable,
    handoffSucceeded: options.handoffSucceeded,
  };

  return {
    taskId: task.taskId,
    dryRun: true,
    classification,
    primaryRole: 'developer',
    delegatedRoles: rolesForClassification(classification.level),
    roles: rolesForClassification(classification.level),
    steps: executionStepsFor(classification.level),
    correctionLimits: correctionLimitsFor(classification.level),
    recommendedChecks: recommendedChecksFor(classification.level),
    context: createContextStrategy(classification, options.mcpAvailable !== false),
    handoff: createHandoffStrategy(task, classification, handoffOptions),
  };
}

export const createExecutionPlan = buildExecutionPlan;
