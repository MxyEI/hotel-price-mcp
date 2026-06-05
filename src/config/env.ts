import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.string().default('info'),
  CLOAK_HEADLESS: z.coerce.boolean().default(false),
  CLOAK_HUMANIZE: z.coerce.boolean().default(true),
  CLOAK_GEOIP: z.coerce.boolean().default(true),
  CLOAK_PROXY_URL: z.string().optional(),
  CLOAK_REQUIRE_PROXY: z.coerce.boolean().default(true),
  CLOAK_FINGERPRINT_ROTATE: z.coerce.boolean().default(true),
  CLOAK_FINGERPRINT_MIN: z.coerce.number().int().positive().default(10_000),
  CLOAK_FINGERPRINT_MAX: z.coerce.number().int().positive().default(999_999_999),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  ARTIFACT_DIR: z.string().default('.artifacts'),
});

export const env = envSchema.parse(process.env);
