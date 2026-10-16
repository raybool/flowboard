import {
  CLASSIFICATION_LEVELS,
  RISK_SIGNALS,
  type Classification,
  type ClassificationLevel,
  type RiskSignal,
  type TaskInput,
} from './types.js';

const SIGNAL_PATTERNS: Record<RiskSignal, readonly RegExp[]> = {
  auth: [
    /\bauth(?:entication|orization)?\b/i,
    /\baccess control\b/i,
    /@public\b|\bjwt\b|\brbac\b|\brefresh token\b/i,
    /аутентификац|авторизац|доступ/i,
  ],
  security: [
    /\bsecurity\b|\bsecure\b|\bvulnerab(?:ility|le)\b/i,
    /@public\b|\bjwt\b|\brbac\b|\brefresh token\b|\bdata[- ]loss\b/i,
    /безопасност|уязвим/i,
  ],
  data: [
    /\bdata\b|\bdatabase\b|\bdb\b|\bschema\b|\bmigration\b/i,
    /\bdata[- ]loss\b/i,
    /данн|баз[аеу]|миграци|схем[аеу]/i,
  ],
  destructive: [
    /\bdestructive\b|\bdata[- ]loss\b/i,
    /\b(?:delete|drop|purge|erase|remove)\s+(?:the\s+)?(?:data|records?|users?|sessions?|schema|tables?|accounts?)\b/i,
    /\b(?:data|records?|users?|sessions?|schema|tables?|accounts?)\s+(?:deletion|removal|purge)\b/i,
    /разрушительн/i,
    /(?:данн|запис|пользовател|сесс|схем|таблиц).*(?:удален|очистк)|(?:удален|очистк).*(?:данн|запис|пользовател|сесс|схем|таблиц)/i,
  ],
  architecture: [
    /\barchitecture\b|\barchitectural\b|\bsystem design\b/i,
    /архитектур|системн(?:ый|ая) дизайн/i,
  ],
  infrastructure: [
    /\binfrastructure\b|\bdeploy(?:ment)?\b|\bproduction\b|\brollback\b|\bci\/cd\b/i,
    /инфраструктур|депло|продакшен|продакшн|откат релиза/i,
  ],
  transaction: [
    /\btransaction(?:al)?\b|\bintegrity\b|\bconsistency\b|\bconcurrency\b/i,
    /транзакц|целостност|согласованност|конкурентност/i,
  ],
};

const FAST_PATTERNS = [
  /\btypo\b|\bformat(?:ting)?\b|\bcomment\b|\bdocumentation\b/i,
  /\brename\b|\btrivial\b|\bsmall fix\b|\blint\b/i,
  /\btypescript utility type\b|\butility type\b|\bDTO\b|\bdecorator\b/i,
  /опечатк|форматирован|комментари|документац|переименован/i,
];

const STANDARD_PATTERNS = [
  /\bCRUD\b|\bendpoint\b|\bservice\b|\bbusiness logic\b|\bintegration\b/i,
  /crud|эндпоинт|сервис|бизнес-логик|интеграц/i,
];

const LEVEL_RANK: Record<ClassificationLevel, number> = {
  FAST: 0,
  STANDARD: 1,
  CRITICAL: 2,
};

function maxLevel(...levels: ClassificationLevel[]): ClassificationLevel {
  return levels.reduce((highest, level) =>
    LEVEL_RANK[level] > LEVEL_RANK[highest] ? level : highest,
  'FAST');
}

function taskText(task: TaskInput): string {
  return [task.title, task.description, ...(task.labels ?? []), ...(task.keywords ?? [])]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

function explicitSignals(task: TaskInput): RiskSignal[] {
  const signals = new Set<RiskSignal>(task.riskSignals ?? []);
  const flags: Array<[RiskSignal, boolean | undefined]> = [
    ['auth', task.requiresAuth],
    ['security', task.touchesSecurity],
    ['data', task.touchesData],
    ['destructive', task.destructive],
    ['architecture', task.changesArchitecture],
    ['infrastructure', task.touchesInfrastructure],
    ['transaction', task.touchesTransactions],
  ];

  for (const [signal, enabled] of flags) {
    if (enabled || task.risk?.[signal]) {
      signals.add(signal);
    }
  }

  return RISK_SIGNALS.filter((signal) => signals.has(signal));
}

function detectedSignals(task: TaskInput): RiskSignal[] {
  const text = taskText(task);
  const signals = new Set<RiskSignal>(explicitSignals(task));

  for (const signal of RISK_SIGNALS) {
    if (SIGNAL_PATTERNS[signal].some((pattern) => pattern.test(text))) {
      signals.add(signal);
    }
  }

  return RISK_SIGNALS.filter((signal) => signals.has(signal));
}

function inferredLevel(task: TaskInput): ClassificationLevel {
  const text = taskText(task);
  const complexityLevel: ClassificationLevel =
    task.complexity === 'critical'
      ? 'CRITICAL'
      : task.complexity === 'standard'
        ? 'STANDARD'
        : 'FAST';
  const scopeLevel: ClassificationLevel =
    task.scope === 'system'
      ? 'CRITICAL'
      : task.scope === 'multi-module'
        ? 'STANDARD'
        : 'FAST';
  const textLevel: ClassificationLevel =
    STANDARD_PATTERNS.some((pattern) => pattern.test(text))
      ? 'STANDARD'
      : FAST_PATTERNS.some((pattern) => pattern.test(text))
        ? 'FAST'
        : 'FAST';

  return maxLevel(complexityLevel, scopeLevel, textLevel);
}

export function classifyTask(task: TaskInput): Classification {
  const signals = detectedSignals(task);
  const baseline = inferredLevel(task);
  const initial = task.initialClassification ?? 'FAST';
  const level = maxLevel(
    initial,
    baseline,
    signals.length > 0 ? 'CRITICAL' : 'FAST',
  );
  const reasons = [
    `baseline:${baseline}`,
    ...(task.initialClassification ? [`initial:${task.initialClassification}`] : []),
    ...signals.map((signal) => `risk:${signal}`),
  ];

  return {
    level,
    signals,
    reasons,
    escalated: level !== initial,
  };
}

export function classificationRank(level: ClassificationLevel): number {
  return LEVEL_RANK[level];
}

export function isClassificationLevel(value: string): value is ClassificationLevel {
  return (CLASSIFICATION_LEVELS as readonly string[]).includes(value);
}

export const classify = classifyTask;
