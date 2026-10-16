import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ContextStore } from './store.js';

test('orchestration audit events preserve mode, stage, event, and escalation reason', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'flowboard-audit-'));
  const databasePath = path.join(directory, 'context.sqlite');
  const store = new ContextStore(databasePath);
  try {
    store.recordAgentEvent({
      taskId: 'FB-003.17',
      mode: 'CRITICAL',
      stage: 'classification',
      agentEvent: 'plan-selected',
      escalationReason: 'risk:auth',
      agentRole: 'developer',
    });

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database
        .prepare(
          `SELECT task_id AS taskId, mode, stage, agent_event AS agentEvent,
                  escalation_reason AS escalationReason, agent_role AS agentRole
           FROM context_audit_log
           WHERE tool = 'orchestration.event'`,
        )
        .get() as {
        taskId: string;
        mode: string;
        stage: string;
        agentEvent: string;
        escalationReason: string;
        agentRole: string;
      };
      assert.deepEqual({ ...row }, {
        taskId: 'FB-003.17',
        mode: 'CRITICAL',
        stage: 'classification',
        agentEvent: 'plan-selected',
        escalationReason: 'risk:auth',
        agentRole: 'developer',
      });
    } finally {
      database.close();
    }

    const stats = store.auditStats({ taskId: 'FB-003.17' });
    assert.equal(stats.byTool['orchestration.event'].calls, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
