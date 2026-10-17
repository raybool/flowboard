import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { Client } from 'pg';

import {
  findLabelNameKeyCollisions,
  normalizeLabelNameKey,
  UNICODE_CASE_FOLD_VERSION,
  type LabelNameKeyRecord,
} from '../src/modules/labels/label-name-normalization.ts';

type BackfillLabel = LabelNameKeyRecord;

const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const confirmed = args.includes('--confirm');
const backupFile = args
  .find((argument) => argument.startsWith('--backup-file='))
  ?.slice('--backup-file='.length);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for the label name_key backfill');
}

if (writeMode && (!confirmed || !backupFile)) {
  throw new Error(
    'Write mode requires both --confirm and --backup-file=/absolute/path.json',
  );
}

if (writeMode && backupFile && !isAbsolute(backupFile)) {
  throw new Error('--backup-file must be an absolute path');
}

const client = new Client({ connectionString: databaseUrl });

async function readLabels(): Promise<BackfillLabel[]> {
  const result = await client.query<BackfillLabel>(
    `SELECT id, workspace_id AS "workspaceId", name, name_key AS "nameKey"
     FROM labels
     ORDER BY workspace_id, id`,
  );
  return result.rows;
}

function changedLabels(labels: readonly BackfillLabel[]) {
  return labels.filter(
    (label) => normalizeLabelNameKey(label.name) !== label.nameKey,
  );
}

async function lockWorkspaces(labels: readonly BackfillLabel[]) {
  const workspaceIds = [
    ...new Set(labels.map((label) => label.workspaceId)),
  ].sort();

  for (const workspaceId of workspaceIds) {
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
      workspaceId,
    ]);
  }
}

try {
  await client.connect();
  const labels = await readLabels();
  const collisions = findLabelNameKeyCollisions(labels);

  console.log(
    JSON.stringify(
      {
        readOnly: !writeMode,
        writeMode,
        unicodeCaseFoldVersion: UNICODE_CASE_FOLD_VERSION,
        labelCount: labels.length,
        changedCount: changedLabels(labels).length,
        collisions: collisions.map((collision) => ({
          workspaceId: collision.workspaceId,
          normalizedNameKey: collision.normalizedNameKey,
          labels: collision.labels.map(({ id, name, nameKey }) => ({
            id,
            name,
            nameKey,
          })),
        })),
      },
      null,
      2,
    ),
  );

  if (collisions.length > 0) {
    console.error(
      'Backfill stopped: resolve every reported workspace collision explicitly, then rerun the dry-run.',
    );
    process.exitCode = 2;
  } else if (!writeMode) {
    console.log(
      'Dry-run only: no name_key values or TaskLabel relations were changed.',
    );
  } else {
    await client.query('BEGIN');
    try {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      // Lock first, then re-read. A concurrent label mutation therefore waits
      // on the same workspace lock and cannot be missed by the final check.
      await lockWorkspaces(labels);
      const lockedLabels = await readLabels();
      const lockedCollisions = findLabelNameKeyCollisions(lockedLabels);
      if (lockedCollisions.length > 0) {
        throw new Error(
          'Legacy collisions appeared while acquiring workspace locks; retry after resolving them',
        );
      }

      // Write the backup only after locks and the final read, so it is the
      // exact pre-write state of the transaction being committed.
      await writeFile(
        backupFile!,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            unicodeCaseFoldVersion: UNICODE_CASE_FOLD_VERSION,
            labels: lockedLabels,
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );

      for (const label of changedLabels(lockedLabels)) {
        await client.query(
          'UPDATE labels SET name_key = $1 WHERE workspace_id = $2 AND id = $3',
          [normalizeLabelNameKey(label.name), label.workspaceId, label.id],
        );
      }

      await client.query('COMMIT');
      console.log(
        `Backfill committed: ${changedLabels(lockedLabels).length} name_key value(s) updated; labels and TaskLabel relations were preserved.`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
} finally {
  await client.end();
}
