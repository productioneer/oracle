import type { Browser, CDPSession } from "playwright";
import type { WindowEvent, WindowReport } from "./types.js";
import type { Telemetry } from "./telemetry.js";

type WindowObserverOptions = {
  intervalMs?: number;
  telemetry?: Telemetry;
  hiddenThreshold?: number;
};

type WindowState = {
  windowId: number;
  left: number;
  top: number;
  width: number;
  height: number;
  windowState: string;
  visible: boolean;
};

export class WindowObserver {
  private timer: ReturnType<typeof setInterval> | null = null;
  private events: WindowEvent[] = [];
  private lastStates = new Map<number, WindowState>();
  private startTime = 0;
  private cdp: CDPSession | null = null;
  private readonly intervalMs: number;
  private readonly telemetry: Telemetry | null;
  private readonly hiddenThreshold: number;
  private polling = false;

  constructor(options?: WindowObserverOptions) {
    this.intervalMs = options?.intervalMs ?? 500;
    this.telemetry = options?.telemetry ?? null;
    // Oracle parks windows at -32000,-32000. A window is considered "parked
    // offscreen" only if BOTH coordinates are far negative, avoiding false
    // negatives on multi-monitor setups where one axis might be moderately
    // negative. Real monitors rarely go beyond -6000 on any axis.
    this.hiddenThreshold = options?.hiddenThreshold ?? -10000;
  }

  async start(browser: Browser): Promise<void> {
    if (this.timer) return;
    this.startTime = Date.now();
    this.events = [];
    this.lastStates.clear();

    this.cdp = await browser.newBrowserCDPSession();

    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.timer.unref?.();
    await this.poll();
  }

  async stop(): Promise<WindowReport> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.cdp) {
      await this.cdp.detach().catch(() => null);
      this.cdp = null;
    }
    return {
      totalEvents: this.events.length,
      violations: this.events.filter((e) => e.visible),
      durationMs: Date.now() - this.startTime,
    };
  }

  getEvents(): WindowEvent[] {
    return [...this.events];
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.cdp) return;
    this.polling = true;
    try {
      const targets = await this.cdp.send("Target.getTargets");
      const pageTargets = (targets?.targetInfos ?? []).filter(
        (t: { type?: string }) => t.type === "page",
      );

      const seenWindowIds = new Set<number>();

      for (const target of pageTargets) {
        try {
          const windowInfo = await this.cdp.send("Browser.getWindowForTarget", {
            targetId: target.targetId,
          });
          if (!windowInfo?.windowId) continue;

          if (seenWindowIds.has(windowInfo.windowId)) continue;
          seenWindowIds.add(windowInfo.windowId);

          const bounds = await this.cdp.send("Browser.getWindowBounds", {
            windowId: windowInfo.windowId,
          });
          if (!bounds?.bounds) continue;

          const b = bounds.bounds;
          const left = b.left ?? 0;
          const top = b.top ?? 0;
          const width = b.width ?? 0;
          const height = b.height ?? 0;
          const windowState = b.windowState ?? "normal";

          const parkedOffscreen =
            left <= this.hiddenThreshold && top <= this.hiddenThreshold;
          const notMinimized = windowState !== "minimized";
          const visible = notMinimized && !parkedOffscreen;

          const current: WindowState = {
            windowId: windowInfo.windowId,
            left,
            top,
            width,
            height,
            windowState,
            visible,
          };

          const previous = this.lastStates.get(windowInfo.windowId);
          if (previous && statesEqual(previous, current)) continue;

          this.lastStates.set(windowInfo.windowId, current);

          const event: WindowEvent = {
            timestamp: new Date().toISOString(),
            ...current,
          };

          this.events.push(event);
          this.telemetry?.emit("window_state", {
            windowId: event.windowId,
            left: event.left,
            top: event.top,
            width: event.width,
            height: event.height,
            windowState: event.windowState,
            visible: event.visible,
          });
        } catch {
          // Target may have closed between enumeration and query
        }
      }
    } catch {
      // CDP session may have been invalidated
    } finally {
      this.polling = false;
    }
  }
}

function statesEqual(a: WindowState, b: WindowState): boolean {
  return (
    a.windowId === b.windowId &&
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.windowState === b.windowState
  );
}
