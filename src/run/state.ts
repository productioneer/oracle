import {
  writeJsonAtomic,
  readJson,
  writeTextAtomic,
  pathExists,
} from "../utils/fs.js";
import type { RunConfig, StatusPayload, ResultPayload } from "./types.js";

export async function saveRunConfig(
  runPath: string,
  config: RunConfig,
): Promise<void> {
  await writeJsonAtomic(runPath, config);
}

export async function loadRunConfig(runPath: string): Promise<RunConfig> {
  return readJson<RunConfig>(runPath);
}

export async function saveStatus(
  statusPath: string,
  status: StatusPayload,
): Promise<void> {
  await writeJsonAtomic(statusPath, status);
}

export async function loadStatus(
  statusPath: string,
): Promise<StatusPayload | null> {
  if (!(await pathExists(statusPath))) return null;
  return readJson<StatusPayload>(statusPath);
}

export async function saveResultJson(
  resultPath: string,
  result: ResultPayload,
): Promise<void> {
  await writeJsonAtomic(resultPath, result);
}

export async function saveResultMarkdown(
  resultPath: string,
  markdown: string,
): Promise<void> {
  await writeTextAtomic(resultPath, markdown);
}
