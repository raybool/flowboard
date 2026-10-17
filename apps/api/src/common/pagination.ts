import { BadRequestException } from '@nestjs/common';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type PaginationCursor = {
  createdAt: string;
  id: string;
};

export function encodePaginationCursor(value: {
  createdAt: Date;
  id: string;
}): string {
  const cursor: PaginationCursor = {
    createdAt: value.createdAt.toISOString(),
    id: value.id,
  };

  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodePaginationCursor(value: string): PaginationCursor {
  try {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length % 4 === 1 ||
      !BASE64URL_PATTERN.test(value)
    ) {
      throw new Error('Invalid cursor encoding');
    }

    const encoded = Buffer.from(value, 'base64url');
    if (encoded.toString('base64url') !== value) {
      throw new Error('Non-canonical cursor encoding');
    }

    const decoded = encoded.toString('utf8');
    const parsed: unknown = JSON.parse(decoded);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2
    ) {
      throw new Error('Invalid cursor shape');
    }

    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.createdAt !== 'string' ||
      typeof cursor.id !== 'string' ||
      !UUID_PATTERN.test(cursor.id) ||
      !ISO_TIMESTAMP_PATTERN.test(cursor.createdAt)
    ) {
      throw new Error('Invalid cursor values');
    }

    const createdAt = new Date(cursor.createdAt);
    if (
      Number.isNaN(createdAt.getTime()) ||
      createdAt.toISOString() !== cursor.createdAt
    ) {
      throw new Error('Invalid cursor values');
    }

    return {
      createdAt: cursor.createdAt,
      id: cursor.id,
    };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

export function cursorWhere(cursor: PaginationCursor) {
  const createdAt = new Date(cursor.createdAt);

  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, id: { lt: cursor.id } },
    ],
  };
}
