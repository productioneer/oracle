import os from 'os';
import path from 'path';

export function defaultRunsRoot(): string {
  return path.join(os.homedir(), '.oracle', 'runs');
}

export function runDir(runId: string, rootDir?: string): string {
  return path.join(rootDir ?? defaultRunsRoot(), runId);
}

export function statusPath(runDirPath: string): string {
  return path.join(runDirPath, 'status.json');
}

export function resultPath(runDirPath: string): string {
  return path.join(runDirPath, 'result.md');
}

export function resultJsonPath(runDirPath: string): string {
  return path.join(runDirPath, 'result.json');
}

export function logPath(runDirPath: string): string {
  return path.join(runDirPath, 'run.log');
}

export function runConfigPath(runDirPath: string): string {
  return path.join(runDirPath, 'run.json');
}
