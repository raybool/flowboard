import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTestDatabase,
  getTestUrl,
  parseDatabaseUrl,
} from './test-database.mjs';

const parse = (url, label = 'TEST_DATABASE_URL') =>
  parseDatabaseUrl(url, label);

test('allows a local database with the _test suffix', () => {
  assert.doesNotThrow(() =>
    assertTestDatabase(
      parse('postgresql://flowboard:secret@localhost:5432/flowboard_test'),
      parse('postgresql://flowboard:secret@localhost:5432/flowboard'),
    ),
  );
});

test('rejects a test database that matches the development database', () => {
  assert.throws(
    () =>
      assertTestDatabase(
        parse('postgresql://flowboard:secret@localhost:5432/flowboard_test'),
        parse(
          'postgresql://flowboard:secret@localhost:5432/flowboard_test',
          'DATABASE_URL',
        ),
      ),
    /development database/,
  );
});

test('rejects a development database without the _test suffix', () => {
  assert.throws(
    () =>
      assertTestDatabase(
        parse('postgresql://flowboard:secret@localhost:5432/flowboard'),
        parse(
          'postgresql://flowboard:secret@localhost:5432/flowboard',
          'DATABASE_URL',
        ),
      ),
    /ending in _test/,
  );
});

test('rejects an unexpected remote host', () => {
  assert.throws(
    () =>
      assertTestDatabase(
        parse(
          'postgresql://flowboard:secret@db.example.test:5432/flowboard_test',
        ),
        parse('postgresql://flowboard:secret@localhost:5432/flowboard'),
      ),
    /local PostgreSQL server/,
  );
});

test('requires a test URL when no development URL is available', () => {
  assert.throws(
    () => getTestUrl({}),
    /TEST_DATABASE_URL is required when DATABASE_URL is not configured/,
  );
});

test('derives a separate test database from the development URL', () => {
  const testDatabase = getTestUrl({
    DATABASE_URL: 'postgresql://flowboard:secret@localhost:5432/flowboard',
  });

  assert.equal(testDatabase.databaseName, 'flowboard_test');
  assert.equal(testDatabase.parsed.hostname, 'localhost');
});

test('does not include credentials in guard errors', () => {
  assert.throws(
    () =>
      assertTestDatabase(
        parse(
          'postgresql://flowboard:super-secret@db.example.test:5432/flowboard_test',
        ),
        parse('postgresql://flowboard:super-secret@localhost:5432/flowboard'),
      ),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.message.includes('super-secret'), false);
      return true;
    },
  );
});
