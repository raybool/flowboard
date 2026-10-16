import { classificationRank } from './classifier.js';
import type { Classification, ClassificationLevel } from './types.js';

export function escalateClassification(
  current: ClassificationLevel,
  requested: ClassificationLevel,
): ClassificationLevel {
  return classificationRank(requested) > classificationRank(current) ? requested : current;
}

export function escalate(
  classification: Classification,
  requested: ClassificationLevel,
): Classification {
  const level = escalateClassification(classification.level, requested);
  if (level === classification.level) {
    return classification;
  }

  return {
    ...classification,
    level,
    reasons: [...classification.reasons, `escalated:${requested}`],
    escalated: true,
  };
}
