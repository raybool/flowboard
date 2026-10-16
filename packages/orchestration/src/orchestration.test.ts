import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionPlan,
  classifyTask,
  escalateClassification,
} from './index.js';

test('T1: FAST handles utility type/DTO locally with Developer as primary', () => {
  const plan = buildExecutionPlan({
    taskId: 'T1',
    title: 'Add a TypeScript DTO decorator',
    description: 'Rename a DTO property in one file.',
    scope: 'single-file',
  });

  assert.equal(plan.classification.level, 'FAST');
  assert.equal(plan.primaryRole, 'developer');
  assert.deepEqual(plan.delegatedRoles, []);
  assert.deepEqual(plan.roles, []);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.recommendedChecks, ['typecheck', 'lint', 'targeted-tests']);
  assert.equal(plan.correctionLimits.maxCycles, 0);
  assert.equal(plan.context.mode, 'knowledge-first');
  assert.equal(plan.handoff.mode, 'none');
});

test('T2: STANDARD keeps an endpoint STANDARD even in one file', () => {
  const plan = buildExecutionPlan({
    taskId: 'T2',
    title: 'Add CRUD endpoint',
    description: 'Implement service and business logic in one file.',
    scope: 'single-file',
  });

  assert.equal(plan.classification.level, 'STANDARD');
  assert.deepEqual(plan.delegatedRoles, ['reviewer']);
  assert.deepEqual(plan.roles, ['reviewer']);
  assert.deepEqual(plan.steps.map((step) => step.role), ['developer', 'reviewer']);
  assert.deepEqual(plan.correctionLimits, { maxCycles: 2 });
  assert.equal(plan.handoff.mode, 'compact-text');
  assert.equal(plan.handoff.reason, 'standard-bounded');
  assert.deepEqual(plan.recommendedChecks, [
    'typecheck',
    'lint',
    'targeted-tests',
    'diff-review',
  ]);
  assert.ok((plan.handoff.text?.length ?? 0) <= 1200);
  assert.equal(plan.context.mode, 'knowledge-first');
});

test('T3: CRITICAL recognizes @Public/JWT/RBAC and uses full workflow', () => {
  const plan = buildExecutionPlan({
    taskId: 'T3',
    title: 'Add @Public JWT endpoint',
    description: 'Use RBAC and a refresh token with security checks.',
  });

  assert.equal(plan.classification.level, 'CRITICAL');
  assert.deepEqual(plan.delegatedRoles, ['architect', 'reviewer', 'qa']);
  assert.deepEqual(plan.roles, ['architect', 'reviewer', 'qa']);
  assert.deepEqual(plan.steps.map((step) => step.role), [
    'architect',
    'developer',
    'reviewer',
    'qa',
  ]);
  assert.equal(plan.handoff.mode, 'task-context');
  assert.ok(plan.recommendedChecks.includes('security-regression'));
  assert.equal(plan.context.mode, 'knowledge-first');
});

test('T4: escalation is monotonic from FAST to CRITICAL', () => {
  const classification = classifyTask({
    taskId: 'T4',
    title: 'Fast @Public auth change',
    description: 'Update RBAC access.',
    initialClassification: 'FAST',
  });

  assert.equal(classification.level, 'CRITICAL');
  assert.equal(escalateClassification('CRITICAL', 'STANDARD'), 'CRITICAL');
  assert.equal(escalateClassification('FAST', 'CRITICAL'), 'CRITICAL');
});

test('classifier takes the maximum of complexity, scope, and text', () => {
  assert.equal(
    classifyTask({
      taskId: 'T4-standard-scope',
      title: 'Rename a DTO',
      complexity: 'fast',
      scope: 'multi-module',
    }).level,
    'STANDARD',
  );
  assert.equal(
    classifyTask({
      taskId: 'T4-critical-scope',
      title: 'Rename a DTO',
      complexity: 'fast',
      scope: 'system',
    }).level,
    'CRITICAL',
  );
});

test('infrastructure and transaction risks escalate to CRITICAL', () => {
  const infrastructure = classifyTask({
    taskId: 'risk-infrastructure',
    title: 'Deploy to production',
    touchesInfrastructure: true,
  });
  const transaction = classifyTask({
    taskId: 'risk-transaction',
    description: 'Preserve transaction integrity during concurrent writes.',
    touchesTransactions: true,
  });

  assert.equal(infrastructure.level, 'CRITICAL');
  assert.ok(infrastructure.signals.includes('infrastructure'));
  assert.equal(transaction.level, 'CRITICAL');
  assert.ok(transaction.signals.includes('transaction'));
});

test('removing a comment is not a destructive data operation', () => {
  const classification = classifyTask({
    taskId: 'safe-comment',
    title: 'Remove a comment',
    scope: 'single-file',
  });

  assert.equal(classification.level, 'FAST');
  assert.ok(!classification.signals.includes('destructive'));
});

test('T5: unavailable MCP uses targeted-source context plus compact handoff', () => {
  const plan = buildExecutionPlan(
    {
      taskId: 'T5',
      title: 'Migrate customer data',
      description: 'Change the database schema and migrate data safely.',
    },
    { mcpAvailable: false },
  );

  assert.equal(plan.classification.level, 'CRITICAL');
  assert.equal(plan.context.mode, 'targeted-source');
  assert.equal(plan.context.source, 'repository');
  assert.equal(plan.context.reason, 'mcp-unavailable');
  assert.equal(plan.handoff.mode, 'compact-text');
  assert.equal(plan.handoff.reason, 'mcp-unavailable');
  assert.ok((plan.handoff.text?.length ?? 0) <= 1200);
});

test('T6: failed CRITICAL handoff uses compact-text fallback', () => {
  const plan = buildExecutionPlan(
    {
      taskId: 'T6',
      title: 'Rotate access credentials',
      description: 'Update security-sensitive authentication configuration.',
    },
    { handoffSucceeded: false },
  );

  assert.equal(plan.classification.level, 'CRITICAL');
  assert.equal(plan.context.mode, 'knowledge-first');
  assert.equal(plan.handoff.mode, 'compact-text');
  assert.equal(plan.handoff.reason, 'handoff-failed');
  assert.match(plan.handoff.text ?? '', /T6/);
});
