import { execFile } from "child_process";
import type { FocusEvent, FocusReport } from "./types.js";
import type { Telemetry } from "./telemetry.js";

type FocusMonitorOptions = {
  intervalMs?: number;
  oracleUserDataDir?: string;
  telemetry?: Telemetry;
};

export class FocusMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private events: FocusEvent[] = [];
  private lastApp = "";
  private lastPid = 0;
  private startTime = 0;
  private readonly intervalMs: number;
  private readonly oracleUserDataDir: string;
  private readonly telemetry: Telemetry | null;
  private polling = false;

  constructor(options?: FocusMonitorOptions) {
    this.intervalMs = options?.intervalMs ?? 200;
    this.oracleUserDataDir =
      options?.oracleUserDataDir ?? `${process.env.HOME}/.oracle/chrome`;
    this.telemetry = options?.telemetry ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.startTime = Date.now();
    this.events = [];
    this.lastApp = "";
    this.lastPid = 0;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    this.poll();
  }

  stop(): FocusReport {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return {
      totalEvents: this.events.length,
      violations: this.events.filter((e) => e.isOracleChrome),
      durationMs: Date.now() - this.startTime,
    };
  }

  getEvents(): FocusEvent[] {
    return [...this.events];
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const info = await getFrontmostApp();
      if (!info) return;

      if (info.name === this.lastApp && info.pid === this.lastPid) return;

      this.lastApp = info.name;
      this.lastPid = info.pid;

      // Only check Chrome-like apps (Chrome, Canary, Chromium, etc.)
      const isChromeLike =
        info.name.includes("Chrome") || info.name.includes("Chromium");
      const isOracleChrome = isChromeLike
        ? await isOracleChromeProcess(info.pid, this.oracleUserDataDir)
        : false;

      const event: FocusEvent = {
        timestamp: new Date().toISOString(),
        app: info.name,
        pid: info.pid,
        isOracleChrome,
      };

      this.events.push(event);
      this.telemetry?.emit("focus_change", {
        app: event.app,
        pid: event.pid,
        isOracleChrome: event.isOracleChrome,
      });
    } finally {
      this.polling = false;
    }
  }
}

type FrontmostInfo = {
  name: string;
  pid: number;
};

async function getFrontmostApp(): Promise<FrontmostInfo | null> {
  if (process.platform !== "darwin") return null;

  const script = [
    'tell application "System Events"',
    "set frontApp to first application process whose frontmost is true",
    "set appName to name of frontApp",
    "set appPid to unix id of frontApp",
    'return appName & "|" & appPid',
    "end tell",
  ];

  return new Promise((resolve) => {
    execFile(
      "osascript",
      script.flatMap((line) => ["-e", line]),
      { timeout: 2000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const parts = stdout.trim().split("|");
        if (parts.length < 2) {
          resolve(null);
          return;
        }
        const name = parts[0];
        const pid = parseInt(parts[1], 10);
        if (!name || isNaN(pid)) {
          resolve(null);
          return;
        }
        resolve({ name, pid });
      },
    );
  });
}

async function isOracleChromeProcess(
  pid: number,
  oracleUserDataDir: string,
): Promise<boolean> {
  // Check if the specific frontmost PID is the Oracle Chrome process
  const directMatch = await checkPidForUserDataDir(pid, oracleUserDataDir);
  if (directMatch) return true;

  // On macOS, the frontmost Chrome PID might be a helper process rather than
  // the main browser process. Check parent-child relationships by looking for
  // Chrome processes where the main process has our user-data-dir AND the
  // frontmost PID appears to be in the same process group.
  //
  // Note: We intentionally DON'T just check "is any Oracle Chrome running" —
  // that would incorrectly flag personal Chrome as a violation when Oracle
  // Chrome is running hidden in the background.
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "ppid=,command="],
      (error, stdout) => {
        if (error) {
          resolve(false);
          return;
        }
        // Check if this process or its parent is Oracle Chrome
        const line = stdout.trim();
        const ppidMatch = line.match(/^\s*(\d+)\s+/);
        if (!ppidMatch) {
          resolve(false);
          return;
        }
        const ppid = parseInt(ppidMatch[1], 10);
        if (isNaN(ppid) || ppid <= 1) {
          resolve(false);
          return;
        }
        // Check the parent process
        checkPidForUserDataDir(ppid, oracleUserDataDir).then(resolve);
      },
    );
  });
}

function checkPidForUserDataDir(
  pid: number,
  oracleUserDataDir: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      resolve(stdout.includes(`--user-data-dir=${oracleUserDataDir}`));
    });
  });
}
