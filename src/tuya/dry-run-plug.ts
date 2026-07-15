import type { Logger } from 'pino';
import type { PlugController, PlugState } from './types.js';

/**
 * A logging no-op PlugController used when DRY_RUN=true. Computes/records
 * intended actions without ever issuing a real Tuya command.
 */
export class DryRunPlug implements PlugController {
  private state: PlugState = 'off';

  constructor(private readonly logger?: Logger) {}

  async turnOn(): Promise<void> {
    this.logger?.info({ dryRun: true, action: 'turnOn' }, 'DRY_RUN: would turn fan ON (no-op)');
    this.state = 'on';
  }

  async turnOff(): Promise<void> {
    this.logger?.info({ dryRun: true, action: 'turnOff' }, 'DRY_RUN: would turn fan OFF (no-op)');
    this.state = 'off';
  }

  async getState(): Promise<PlugState> {
    return this.state;
  }
}
