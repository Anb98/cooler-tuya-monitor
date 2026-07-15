import pino, { type Logger } from 'pino';
import { loadConfig, type Config } from './config/env.js';
import { SysfsCpuSensor } from './sensors/sysfs-cpu.js';
import { SmartctlHddSensor } from './sensors/smartctl-hdd.js';
import type { TemperatureSensor } from './sensors/types.js';
import { TuyapiLocalPlug } from './tuya/tuyapi-local.js';
import { DryRunPlug } from './tuya/dry-run-plug.js';
import type { PlugController } from './tuya/types.js';
import { RealClock } from './control/clock.js';
import type { Clock } from './control/clock.js';
import { ControlLoop } from './control/loop.js';
import type { ThresholdConfig } from './control/types.js';
import { buildServer } from './http/server.js';

export interface BootstrapOverrides {
  config?: Config;
  logger?: Logger;
  sensors?: TemperatureSensor[];
  plug?: PlugController;
  clock?: Clock;
  /** Skip process.on(SIGTERM/SIGINT) registration — used in tests. */
  registerSignalHandlers?: boolean;
  /** Skip actually calling server.listen() — used in tests. */
  startHttpListener?: boolean;
}

/**
 * Wires config -> sensors -> plug -> control loop -> HTTP server. Accepts
 * overrides so tests can inject fakes without touching real hardware,
 * process signals, or network sockets.
 */
export function bootstrap(overrides: BootstrapOverrides = {}) {
  const config = overrides.config ?? loadConfig();
  // The logger is created early with a sane default so config-load errors can
  // be reported, then its level is aligned to the validated config below.
  const logger = overrides.logger ?? pino({ level: 'info' });
  if (!overrides.logger) {
    logger.level = config.LOG_LEVEL;
  }

  const sensors: TemperatureSensor[] =
    overrides.sensors ?? [new SysfsCpuSensor(), new SmartctlHddSensor({ devices: config.HDD_DEVICES })];

  const plug: PlugController =
    overrides.plug ??
    (config.DRY_RUN
      ? new DryRunPlug(logger)
      : new TuyapiLocalPlug({
          id: config.TUYA_DEVICE_ID,
          key: config.TUYA_LOCAL_KEY,
          ip: config.TUYA_IP,
          version: config.TUYA_VERSION,
          logger,
        }));

  const thresholds: ThresholdConfig = {
    cpuHigh: config.CPU_TEMP_HIGH,
    cpuLow: config.CPU_TEMP_LOW,
    cpuCritical: config.CPU_TEMP_CRITICAL,
    hddHigh: config.HDD_TEMP_HIGH,
    hddLow: config.HDD_TEMP_LOW,
    hddCritical: config.HDD_TEMP_CRITICAL,
    offDwellSec: config.OFF_DWELL_SEC,
    minOnSec: config.MIN_ON_SEC,
  };

  const loop = new ControlLoop({
    sensors,
    plug,
    clock: overrides.clock ?? new RealClock(),
    thresholds,
    dryRun: config.DRY_RUN,
    logger,
  });

  loop.start(config.POLL_INTERVAL_SEC * 1000);
  logger.info({ pollIntervalSec: config.POLL_INTERVAL_SEC }, 'control loop started');

  let server: ReturnType<typeof buildServer> | null = null;
  if (config.HTTP_ENABLED) {
    server = buildServer({ controlState: loop.state, logger });
    if (overrides.startHttpListener !== false) {
      server.listen({ port: config.PORT, host: config.HTTP_HOST }, (err, address) => {
        if (err) {
          logger.error({ err }, 'failed to start HTTP server');
          return;
        }
        logger.info({ address }, 'HTTP server listening');
      });
    }
  }

  const shutdown = (signal: string) => {
    logger.warn(
      { signal },
      'received shutdown signal — stopping control loop, leaving plug ON per fail-safe policy (not turning fan off)',
    );
    loop.stop();
    if (server) {
      void server.close();
    }
    process.exit(0);
  };

  if (overrides.registerSignalHandlers !== false) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Process-level backstops (real-run path only — gated behind the same
    // condition as the signal handlers so tests never register them).
    // These must NOT turn the plug off: on uncaughtException we exit(1) so
    // Docker `restart: unless-stopped` recovers cleanly and fail-safe (fan ON)
    // is re-derived on the next boot's first tick.
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason.message : String(reason);
      logger.error({ err }, 'unhandled promise rejection');
    });
    process.on('uncaughtException', (err) => {
      logger.fatal({ err: err.message }, 'uncaught exception — exiting for clean restart');
      process.exit(1);
    });
  }

  return { config, logger, loop, server, shutdown };
}

/* c8 ignore start */
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  bootstrap();
}
/* c8 ignore stop */
