import { z } from 'zod';

const boolFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const envSchema = z.object({
  CPU_TEMP_HIGH: z.coerce.number().default(60),
  CPU_TEMP_LOW: z.coerce.number().default(48),
  CPU_TEMP_CRITICAL: z.coerce.number().default(80),

  HDD_TEMP_HIGH: z.coerce.number().default(48),
  HDD_TEMP_LOW: z.coerce.number().default(42),
  HDD_TEMP_CRITICAL: z.coerce.number().default(55),

  POLL_INTERVAL_SEC: z.coerce.number().default(30),
  OFF_DWELL_SEC: z.coerce.number().default(300),
  MIN_ON_SEC: z.coerce.number().default(120),

  HDD_DEVICES: z
    .string()
    .default('sda,sdb,sdc,sdd,sde')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),

  TUYA_DEVICE_ID: z.string().min(1, 'TUYA_DEVICE_ID is required'),
  TUYA_LOCAL_KEY: z.string().min(1, 'TUYA_LOCAL_KEY is required'),
  TUYA_IP: z.string().min(1, 'TUYA_IP is required'),
  TUYA_VERSION: z.string().default('3.3'),

  DRY_RUN: boolFromString.default('false'),
  FAIL_SAFE: boolFromString.default('true'),
  HTTP_ENABLED: boolFromString.default('true'),
  PORT: z.coerce.number().default(3000),
  HTTP_HOST: z.string().default('0.0.0.0'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
}).superRefine((cfg, ctx) => {
  // Thresholds must be strictly ordered LOW < HIGH < CRITICAL so hysteresis
  // and the critical-safety override cannot contradict each other. Fail fast
  // on a misconfiguration rather than running with undefined behavior.
  if (!(cfg.CPU_TEMP_LOW < cfg.CPU_TEMP_HIGH && cfg.CPU_TEMP_HIGH < cfg.CPU_TEMP_CRITICAL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['CPU_TEMP_LOW'],
      message: 'CPU thresholds must satisfy CPU_TEMP_LOW < CPU_TEMP_HIGH < CPU_TEMP_CRITICAL',
    });
  }
  if (!(cfg.HDD_TEMP_LOW < cfg.HDD_TEMP_HIGH && cfg.HDD_TEMP_HIGH < cfg.HDD_TEMP_CRITICAL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['HDD_TEMP_LOW'],
      message: 'HDD thresholds must satisfy HDD_TEMP_LOW < HDD_TEMP_HIGH < HDD_TEMP_CRITICAL',
    });
  }
});

export type Config = z.infer<typeof envSchema>;

/**
 * Parses and validates process environment variables. Fails fast: on
 * invalid/missing required config, logs a clear error and exits the
 * process rather than starting the control loop in an undefined state.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(
      `Invalid configuration. The service will not start.\n${details}`,
    );
    process.exit(1);
  }
  return result.data;
}
