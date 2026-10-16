import type {
  Classification,
  ClassificationLevel,
  ContextStrategy,
} from './types.js';

function levelOf(classification: Classification | ClassificationLevel): ClassificationLevel {
  return typeof classification === 'string' ? classification : classification.level;
}

export function createContextStrategy(
  classification: Classification | ClassificationLevel,
  mcpAvailable = true,
): ContextStrategy {
  const level = levelOf(classification);

  if (!mcpAvailable) {
    return {
      classification: level,
      mode: 'targeted-source',
      strategy: 'targeted-source',
      source: 'repository',
      reason: 'mcp-unavailable',
    };
  }

  return {
    classification: level,
    mode: 'knowledge-first',
    strategy: 'knowledge-first',
    source: 'mcp',
    reason: 'mcp-available',
  };
}
