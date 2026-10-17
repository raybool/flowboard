import { BadRequestException } from '@nestjs/common';

import {
  cursorWhere,
  decodePaginationCursor,
  encodePaginationCursor,
} from './pagination';

describe('pagination cursors', () => {
  const validPayload = {
    createdAt: '2026-01-02T03:04:05.000Z',
    id: '11111111-1111-4111-8111-111111111111',
  };

  function encodePayload(payload: unknown): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  function encodeRawPayload(payload: string): string {
    return Buffer.from(payload, 'utf8').toString('base64url');
  }

  function expectInvalidCursor(value: string): void {
    expect(() => decodePaginationCursor(value)).toThrow(
      new BadRequestException('Invalid cursor'),
    );
  }

  it('round-trips the opaque Base64URL cursor payload', () => {
    const cursor = encodePaginationCursor({
      createdAt: new Date(validPayload.createdAt),
      id: validPayload.id,
    });

    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('/');
    expect(decodePaginationCursor(cursor)).toEqual({
      createdAt: '2026-01-02T03:04:05.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('rejects a cursor with an additional invalid Base64URL character', () => {
    expectInvalidCursor(`${encodePayload(validPayload)}!`);
  });

  it('rejects padded Base64URL cursors', () => {
    expectInvalidCursor(`${encodePayload(validPayload)}=`);
  });

  it('rejects a cursor with an invalid UUID', () => {
    expectInvalidCursor(encodePayload({ ...validPayload, id: 'not-a-uuid' }));
  });

  it('rejects a cursor with an invalid ISO timestamp', () => {
    expectInvalidCursor(
      encodePayload({ ...validPayload, createdAt: 'not-a-date' }),
    );
  });

  it('rejects a cursor with damaged JSON', () => {
    expectInvalidCursor(encodeRawPayload('{"createdAt":'));
  });

  it('rejects an empty cursor', () => {
    expectInvalidCursor('');
  });

  it('rejects non-canonical Base64URL trailing bits', () => {
    const canonical = Buffer.from(`${JSON.stringify(validPayload)} `).toString(
      'base64url',
    );
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastCharacter = canonical.at(-1);
    if (!lastCharacter) {
      throw new Error('Expected a non-empty cursor');
    }
    const lastIndex = alphabet.indexOf(lastCharacter);
    const nonCanonicalLastCharacter = alphabet[lastIndex + 1];

    expect(canonical.length % 4).toBe(2);
    expect(nonCanonicalLastCharacter).toBeDefined();
    expectInvalidCursor(
      `${canonical.slice(0, -1)}${nonCanonicalLastCharacter}`,
    );
  });

  it('uses createdAt first and id as the deterministic tie-breaker', () => {
    const createdAt = '2026-01-02T03:04:05.000Z';

    expect(cursorWhere({ createdAt, id: 'cursor-id' })).toEqual({
      OR: [
        { createdAt: { lt: new Date(createdAt) } },
        { createdAt: new Date(createdAt), id: { lt: 'cursor-id' } },
      ],
    });
  });

  it.each(['not-base64-json', 'eyJjcmVhdGVkQXQiOjF9'])(
    'rejects invalid cursor %j without exposing parsing details',
    expectInvalidCursor,
  );
});
