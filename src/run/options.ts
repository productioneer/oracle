import type { RunConfig } from './types.js';

export type RunOverrides = {
  allowVisible?: boolean;
  allowKill?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  thinking?: RunConfig['thinking'];
};

export function applyRunOverrides(config: RunConfig, overrides: RunOverrides): RunConfig {
  if (overrides.allowVisible !== undefined) {
    config.allowVisible = overrides.allowVisible;
  }
  if (overrides.allowKill !== undefined) {
    config.allowKill = overrides.allowKill;
  }
  if (overrides.timeoutMs !== undefined) {
    config.timeoutMs = overrides.timeoutMs;
  }
  if (overrides.pollMs !== undefined) {
    config.pollMs = overrides.pollMs;
  }
  if (overrides.thinking !== undefined) {
    config.thinking = overrides.thinking;
  }
  return config;
}
