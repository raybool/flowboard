import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required'),

  FRONTEND_URL: z.url().default('http://localhost:3000'),

  SWAGGER_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  JWT_ACCESS_SECRET: z.string().min(32),

  JWT_ACCESS_EXPIRES_IN: z
    .string()
    .regex(/^[1-9]\d*(s|m|h|d)$/, 'Use a duration such as 15m')
    .default('15m')
    .transform((value) => {
      const unit = value.slice(-1);
      const amount = Number(value.slice(0, -1));
      const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[
        unit as 's' | 'm' | 'h' | 'd'
      ];
      return amount * multiplier;
    })
    .pipe(z.number().int().positive().safe()),

  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
});

export type EnvConfig = z.infer<typeof envSchema>;
