import fs from "fs";
import path from "path";
import type { RunConfig, StatusPayload } from "./types.js";
import { pathExists, readJson } from "../utils/fs.js";

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
const ACTIVE_STATES = new Set(["starting", "running", "needs_user"]);

export async function cleanupRunsRoot(
  runsRoot: string,
  options: { ttlMs?: number; logger?: (msg: string) => void } = {},
): Promise<void> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const logger = options.logger;
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(runsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot, entry.name);
    const runJson = path.join(runDir, "run.json");
    const statusJson = path.join(runDir, "status.json");
    let createdAtMs: number | null = null;
    if (await pathExists(runJson)) {
      try {
        const config = await readJson<RunConfig>(runJson);
        if (config.createdAt) {
          const parsed = Date.parse(config.createdAt);
          if (!Number.isNaN(parsed)) createdAtMs = parsed;
        }
      } catch {
        // ignore invalid run.json
      }
    }
    if (createdAtMs === null) {
      try {
        const stats = await fs.promises.stat(runDir);
        createdAtMs = stats.mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - createdAtMs < ttlMs) continue;
    if (await pathExists(statusJson)) {
      try {
        const status = await readJson<StatusPayload>(statusJson);
        if (ACTIVE_STATES.has(status.state)) continue;
      } catch {
        // ignore invalid status.json
      }
    }
    try {
      await fs.promises.rm(runDir, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger?.(`[cleanup] failed to remove ${entry.name}: ${String(error)}`);
    }
  }
  if (removed > 0) {
    logger?.(`[cleanup] removed ${removed} run(s) older than ${ttlMs}ms`);
  }
}
