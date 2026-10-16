import { envSchema } from './env.schema';

const base = {
  DATABASE_URL: 'postgresql://example.invalid/test',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
};

describe('JWT expiration configuration', () => {
  it.each([
    ['30s', 30],
    ['15m', 900],
    ['2h', 7200],
    ['1d', 86400],
  ])('converts %s into seconds', (input, seconds) => {
    expect(envSchema.parse({ ...base, JWT_ACCESS_EXPIRES_IN: input })
      .JWT_ACCESS_EXPIRES_IN).toBe(seconds);
  });

  it.each(['15', '0s', '15ms', '999999999999999999999d'])
    ('rejects ambiguous or unsafe durations: %s', (input) => {
      expect(() => envSchema.parse({ ...base, JWT_ACCESS_EXPIRES_IN: input }))
        .toThrow();
    });

  it('does not trust proxies unless explicitly configured', () => {
    expect(envSchema.parse(base).TRUST_PROXY_HOPS).toBe(0);
  });
});
