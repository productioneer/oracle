import path from "path";

export async function listPersonalChromePids(
  oracleUserDataDir: string,
): Promise<number[]> {
  const { execFile } = await import("child_process");
  const output = await new Promise<string>((resolve) => {
    execFile("ps", ["-ax", "-o", "pid=,command="], (err, stdout) => {
      if (err) return resolve("");
      resolve(stdout);
    });
  });
  const normalizedOracle = path.resolve(oracleUserDataDir);
  const lines = output.split(/\n/);
  const pids: number[] = [];
  for (const line of lines) {
    if (!line.includes("Google Chrome")) continue;
    if (line.includes("--type=")) continue;
    if (line.includes(`--user-data-dir=${normalizedOracle}`)) continue;
    const match = line.trim().match(/^(\d+)/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid)) continue;
    pids.push(pid);
  }
  return Array.from(new Set(pids));
}

export async function isPersonalChromeRunning(
  oracleUserDataDir: string,
): Promise<boolean> {
  const pids = await listPersonalChromePids(oracleUserDataDir);
  return pids.length > 0;
}

export async function openPersonalChrome(
  logger?: (message: string) => void,
): Promise<void> {
  if (process.platform !== "darwin") {
    logger?.("[personal-chrome] open skipped; unsupported platform");
    return;
  }
  const { spawn } = await import("child_process");
  const args = ["-g", "-a", "Google Chrome"];
  logger?.(`[personal-chrome] launching: open ${args.join(" ")}`);
  spawn("open", args, { stdio: "ignore", detached: true }).unref();
}

export function shouldRestartPersonalChrome(
  pidsBefore: number[],
  pidsAfter: number[],
): boolean {
  return pidsBefore.length > 0 && pidsAfter.length === 0;
}
