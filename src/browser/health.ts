import http from "http";
import type { Browser, Page } from "playwright";
import { withTimeout } from "../utils/timeout.js";

export type HealthStatus = {
  ok: boolean;
  reason?: string;
};

export async function checkDebugEndpoint(
  port: number,
  timeoutMs = 1500,
): Promise<HealthStatus> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `debug-endpoint: ${String(error)}` };
  }
}

export async function checkBrowserRuntime(
  browser: Browser,
  timeoutMs = 1500,
): Promise<HealthStatus> {
  try {
    const hasCDP = typeof (browser as any).newBrowserCDPSession === "function";
    if (!hasCDP) {
      return { ok: true };
    }
    const client = await (browser as any).newBrowserCDPSession();
    await withTimeout(
      client.send("Runtime.evaluate", { expression: "1+1" }),
      timeoutMs,
      "runtime timeout",
    );
    await client.detach();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `runtime: ${String(error)}` };
  }
}

export async function checkPageResponsive(
  page: Page,
  timeoutMs = 1500,
): Promise<HealthStatus> {
  try {
    await withTimeout(
      page.evaluate(() => 1 + 1),
      timeoutMs,
      "page evaluate timeout",
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `page: ${String(error)}` };
  }
}

async function fetchJson(url: string, timeoutMs = 2_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
  });
}
