import { Client } from 'pg';

import {
  findLabelNameKeyCollisions,
  UNICODE_CASE_FOLD_VERSION,
  type LabelNameKeyRecord,
} from '../src/modules/labels/label-name-normalization.ts';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is required for the read-only collision report',
  );
}

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();

  const result = await client.query<LabelNameKeyRecord>(
    `SELECT id, workspace_id AS "workspaceId", name, name_key AS "nameKey"
     FROM labels
     ORDER BY workspace_id, id`,
  );
  const collisions = findLabelNameKeyCollisions(result.rows);

  console.log(
    JSON.stringify(
      {
        readOnly: true,
        unicodeCaseFoldVersion: UNICODE_CASE_FOLD_VERSION,
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
      'Resolve every reported group explicitly (rename or remove a chosen label), rerun this report until empty, and only then perform a reviewed name_key backfill. No user names are changed by this command.',
    );
    process.exitCode = 2;
  }
} finally {
  await client.end();
}
