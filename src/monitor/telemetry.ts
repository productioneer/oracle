import fs from "fs";
import path from "path";
import type { TelemetryEvent } from "./types.js";

export class Telemetry {
  private stream: fs.WriteStream | null = null;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private eventCount = 0;

  constructor(
    private readonly outputPath: string,
    options?: { flushIntervalMs?: number },
  ) {
    this.flushIntervalMs = options?.flushIntervalMs ?? 1000;
  }

  async open(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.outputPath), { recursive: true });
    this.stream = fs.createWriteStream(this.outputPath, {
      flags: "a",
      encoding: "utf8",
    });
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  emit(type: string, data: Record<string, unknown>): void {
    const event: TelemetryEvent = {
      timestamp: new Date().toISOString(),
      type,
      data,
    };
    this.buffer.push(JSON.stringify(event));
    this.eventCount += 1;
  }

  flush(): void {
    if (this.buffer.length === 0 || !this.stream) return;
    const chunk = this.buffer.join("\n") + "\n";
    this.buffer.length = 0;
    this.stream.write(chunk);
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    if (this.stream) {
      await new Promise<void>((resolve, reject) => {
        this.stream!.end((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.stream = null;
    }
  }

  getEventCount(): number {
    return this.eventCount;
  }
}

export async function readTelemetryLog(
  filePath: string,
): Promise<TelemetryEvent[]> {
  const content = await fs.promises.readFile(filePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TelemetryEvent);
}

export function filterEvents(
  events: TelemetryEvent[],
  type: string,
): TelemetryEvent[] {
  return events.filter((e) => e.type === type);
}

export function filterEventsByTimeRange(
  events: TelemetryEvent[],
  startTime: string,
  endTime: string,
): TelemetryEvent[] {
  return events.filter(
    (e) => e.timestamp >= startTime && e.timestamp <= endTime,
  );
}
