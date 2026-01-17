import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import type { Logger } from '../utils/log.js';

export type FirefoxLaunchOptions = {
  profilePath?: string;
  allowVisible?: boolean;
  logger?: Logger;
};

export type FirefoxConnection = {
  browser: Browser;
};

export async function launchFirefox(options: FirefoxLaunchOptions): Promise<FirefoxConnection> {
  const args: string[] = [];
  if (options.profilePath) {
    const resolvedProfile = path.resolve(options.profilePath);
    await fs.promises.mkdir(resolvedProfile, { recursive: true });
    args.push('-profile', resolvedProfile);
  }
  if (!options.allowVisible) {
    // Best-effort: keep window in background; Firefox may still focus.
    args.push('-new-instance');
  }
  options.logger?.(`[firefox] launch (bidi) args: ${args.join(' ')}`);
  const browser = await puppeteer.launch({
    browser: 'firefox',
    headless: false,
    args,
  });
  return { browser };
}
