import type {
  AgentRole,
  ClassificationLevel,
  CorrectionLimits,
  ExecutionStep,
  RecommendedCheck,
} from './types.js';

const ROLES_BY_LEVEL: Record<ClassificationLevel, readonly AgentRole[]> = {
  FAST: [],
  STANDARD: ['reviewer'],
  CRITICAL: ['architect', 'reviewer', 'qa'],
};

const WORKFLOW_ROLES_BY_LEVEL: Record<ClassificationLevel, readonly AgentRole[]> = {
  FAST: [],
  STANDARD: ['developer', 'reviewer'],
  CRITICAL: ['architect', 'developer', 'reviewer', 'qa'],
};

const CHECKS_BY_LEVEL: Record<ClassificationLevel, readonly RecommendedCheck[]> = {
  FAST: ['typecheck', 'lint', 'targeted-tests'],
  STANDARD: ['typecheck', 'lint', 'targeted-tests', 'diff-review'],
  CRITICAL: [
    'typecheck',
    'lint',
    'targeted-tests',
    'diff-review',
    'security-regression',
    'audit-stats',
  ],
};

export function rolesForClassification(level: ClassificationLevel): readonly AgentRole[] {
  return ROLES_BY_LEVEL[level];
}

export function correctionLimitsFor(level: ClassificationLevel): CorrectionLimits {
  return {
    maxCycles: level === 'FAST' ? 0 : 2,
  };
}

export function executionStepsFor(level: ClassificationLevel): readonly ExecutionStep[] {
  return WORKFLOW_ROLES_BY_LEVEL[level].map((role, index) => ({
    order: index + 1,
    role,
  }));
}

export function recommendedChecksFor(
  level: ClassificationLevel,
): readonly RecommendedCheck[] {
  return CHECKS_BY_LEVEL[level];
}
