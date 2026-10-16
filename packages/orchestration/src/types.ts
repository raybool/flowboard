export const CLASSIFICATION_LEVELS = ['FAST', 'STANDARD', 'CRITICAL'] as const;

export type ClassificationLevel = (typeof CLASSIFICATION_LEVELS)[number];

export const AGENT_ROLES = [
  'prompt_engineer',
  'designer',
  'architect',
  'developer',
  'reviewer',
  'qa',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const RISK_SIGNALS = [
  'auth',
  'security',
  'data',
  'destructive',
  'architecture',
  'infrastructure',
  'transaction',
] as const;

export type RiskSignal = (typeof RISK_SIGNALS)[number];

export interface TaskInput {
  taskId: string;
  title?: string;
  description?: string;
  labels?: readonly string[];
  keywords?: readonly string[];
  riskSignals?: readonly RiskSignal[];
  risk?: Partial<Record<RiskSignal, boolean>>;
  complexity?: 'fast' | 'standard' | 'critical';
  scope?: 'single-file' | 'multi-module' | 'system';
  initialClassification?: ClassificationLevel;
  requiresAuth?: boolean;
  touchesSecurity?: boolean;
  touchesData?: boolean;
  destructive?: boolean;
  changesArchitecture?: boolean;
  touchesInfrastructure?: boolean;
  touchesTransactions?: boolean;
}

export interface Classification {
  level: ClassificationLevel;
  signals: readonly RiskSignal[];
  reasons: readonly string[];
  escalated: boolean;
}

export interface CorrectionLimits {
  maxCycles: number;
}

export type RecommendedCheck =
  | 'typecheck'
  | 'lint'
  | 'targeted-tests'
  | 'diff-review'
  | 'security-regression'
  | 'audit-stats';

export interface ExecutionStep {
  order: number;
  role: AgentRole;
}

export type ContextStrategyMode = 'knowledge-first' | 'targeted-source';

export interface ContextStrategy {
  classification: ClassificationLevel;
  mode: ContextStrategyMode;
  strategy: ContextStrategyMode;
  source: 'mcp' | 'repository';
  reason: 'mcp-available' | 'mcp-unavailable';
}

export type HandoffStrategyMode = 'none' | 'task-context' | 'compact-text';

export interface HandoffStrategy {
  mode: HandoffStrategyMode;
  strategy: HandoffStrategyMode;
  source: 'none' | 'policy' | 'mcp' | 'fallback';
  reason:
    | 'not-required'
    | 'standard-bounded'
    | 'mcp-available'
    | 'mcp-unavailable'
    | 'handoff-failed';
  text?: string;
}

export interface ExecutionPlan {
  taskId: string;
  dryRun: true;
  classification: Classification;
  primaryRole: 'developer';
  delegatedRoles: readonly AgentRole[];
  roles: readonly AgentRole[];
  steps: readonly ExecutionStep[];
  correctionLimits: CorrectionLimits;
  recommendedChecks: readonly RecommendedCheck[];
  context: ContextStrategy;
  handoff: HandoffStrategy;
}
