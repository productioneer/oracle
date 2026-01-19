import path from 'path';
import { nowIso } from '../utils/time.js';
import { pathExists, readJson, writeJsonAtomic } from '../utils/fs.js';

export type ThinkingState = {
  cursor: number;
  prefix: string;
  updatedAt: string;
};

export function thinkingStatePath(runDirPath: string): string {
  return path.join(runDirPath, 'thinking.json');
}

export async function readThinkingState(runDirPath: string): Promise<ThinkingState | null> {
  const statePath = thinkingStatePath(runDirPath);
  if (!(await pathExists(statePath))) return null;
  return readJson<ThinkingState>(statePath);
}

export async function saveThinkingState(runDirPath: string, state: ThinkingState): Promise<void> {
  await writeJsonAtomic(thinkingStatePath(runDirPath), state);
}

export function buildThinkingState(fullText: string): ThinkingState {
  return {
    cursor: fullText.length,
    prefix: fullText.slice(0, 200),
    updatedAt: nowIso(),
  };
}

export function computeThinkingIncrement(
  fullText: string,
  state: ThinkingState | null,
): { chunk: string; nextState: ThinkingState } {
  const nextState = buildThinkingState(fullText);
  if (!state) {
    return { chunk: fullText, nextState };
  }
  if (!fullText.startsWith(state.prefix) || state.cursor > fullText.length) {
    return { chunk: fullText, nextState };
  }
  return { chunk: fullText.slice(state.cursor), nextState };
}
