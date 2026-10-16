import type {
  Classification,
  ClassificationLevel,
  HandoffStrategy,
  TaskInput,
} from './types.js';

export const COMPACT_HANDOFF_MAX_CHARS = 1200;

export interface HandoffOptions {
  mcpAvailable?: boolean;
  handoffSucceeded?: boolean;
}

function levelOf(classification: Classification | ClassificationLevel): ClassificationLevel {
  return typeof classification === 'string' ? classification : classification.level;
}

function compactText(task: TaskInput): string {
  const title = task.title?.trim() || task.taskId;
  const description = task.description?.trim() || 'No description provided.';
  const labels = task.labels?.length ? ` Labels: ${task.labels.join(', ')}.` : '';
  const text = `Task ${task.taskId}: ${title}. ${description}${labels}`.replace(/\s+/g, ' ');

  return text.length <= COMPACT_HANDOFF_MAX_CHARS
    ? text
    : `${text.slice(0, COMPACT_HANDOFF_MAX_CHARS - 1)}…`;
}

export function createHandoffStrategy(
  task: TaskInput,
  classification: Classification | ClassificationLevel,
  options: HandoffOptions = {},
): HandoffStrategy {
  const level = levelOf(classification);
  if (level === 'FAST') {
    return {
      mode: 'none',
      strategy: 'none',
      source: 'none',
      reason: 'not-required',
    };
  }

  if (level === 'STANDARD') {
    return {
      mode: 'compact-text',
      strategy: 'compact-text',
      source: 'policy',
      reason: 'standard-bounded',
      text: compactText(task),
    };
  }

  if (options.mcpAvailable === false) {
    return {
      mode: 'compact-text',
      strategy: 'compact-text',
      source: 'fallback',
      reason: 'mcp-unavailable',
      text: compactText(task),
    };
  }

  if (options.handoffSucceeded === false) {
    return {
      mode: 'compact-text',
      strategy: 'compact-text',
      source: 'fallback',
      reason: 'handoff-failed',
      text: compactText(task),
    };
  }

  return {
    mode: 'task-context',
    strategy: 'task-context',
    source: 'mcp',
    reason: 'mcp-available',
  };
}

export { compactText as buildCompactHandoffText };
