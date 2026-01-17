import type { RunConfig } from './types.js';

export type RunOverrides = {
  allowVisible?: boolean;
  allowKill?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  stableMs?: number;
  stallMs?: number;
};

export function resolveStallMs(timeoutMs: number, stallMs?: number): number {
  if (typeof stallMs === 'number' && Number.isFinite(stallMs) && stallMs > 0) {
    return Math.floor(stallMs);
  }
  const min = 120_000;
  const max = 30 * 60 * 1000;
  const computed = Math.floor(timeoutMs * 0.2);
  const bounded = Math.min(max, Math.max(min, computed));
  return Math.min(timeoutMs, bounded);
}

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
  if (overrides.stableMs !== undefined) {
    config.stableMs = overrides.stableMs;
  }
  if (overrides.stallMs !== undefined) {
    config.stallMs = overrides.stallMs;
  }
  return config;
}
