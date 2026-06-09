import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }

  return value;
}, z.boolean()).default(defaultValue);

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.string().default('info'),
  CLOAK_HEADLESS: booleanFromEnv(false),
  CLOAK_HUMANIZE: booleanFromEnv(true),
  CLOAK_GEOIP: booleanFromEnv(true),
  CLOAK_PROXY_URL: z.string().optional(),
  CLOAK_REQUIRE_PROXY: booleanFromEnv(true),
  CLOAK_FINGERPRINT_ROTATE: booleanFromEnv(true),
  CLOAK_FINGERPRINT_MIN: z.coerce.number().int().positive().default(10_000),
  CLOAK_FINGERPRINT_MAX: z.coerce.number().int().positive().default(999_999_999),
  QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  PROVIDER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  ARTIFACT_DIR: z.string().default('.artifacts'),
});

export const env = envSchema.parse(process.env);
