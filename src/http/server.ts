import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { SharedControlState } from '../control/loop.js';

export interface BuildServerOptions {
  controlState: SharedControlState;
  logger?: Logger | boolean;
}

/**
 * Builds (but does not start listening on) a Fastify instance exposing the
 * read-only status/health endpoints and the manual-override actions. All
 * handlers read/mutate the SharedControlState reference produced by the
 * ControlLoop — single-threaded event loop, so no locking is needed.
 */
export function buildServer(options: BuildServerOptions): FastifyInstance {
  const app = (
    options.logger && typeof options.logger !== 'boolean'
      ? Fastify({ loggerInstance: options.logger })
      : Fastify({ logger: options.logger ?? false })
  ) as FastifyInstance;
  const { controlState } = options;

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/status', async () => {
    const decision = controlState.lastDecision;
    return {
      fanOn: decision?.fanOn ?? null, // Legacy desired state; not physical confirmation.
      confirmedFanOn: controlState.appliedFanOn,
      plugCommsOk: controlState.plugCommsOk,
      state: controlState.memory.state,
      mode: controlState.override === null ? 'auto' : 'manual',
      override: controlState.override,
      temps: {
        cpu: controlState.lastMaxCpu,
        hdd: controlState.lastMaxHdd,
      },
      lastDecision: decision
        ? { action: decision.action, reason: decision.reason }
        : null,
    };
  });

  app.post('/fan/on', async () => {
    controlState.override = 'on';
    return { override: 'on' };
  });

  app.post('/fan/off', async () => {
    controlState.override = 'off';
    return { override: 'off' };
  });

  app.post('/fan/auto', async () => {
    controlState.override = null;
    return { override: null, mode: 'auto' };
  });

  return app;
}
