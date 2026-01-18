import fs from 'fs';
import os from 'os';
import path from 'path';

export type FirefoxAppConfig = {
  appPath: string;
  appName: string;
  executablePath: string;
  source: 'cli' | 'env' | 'auto';
};

const DEFAULT_APP_NAMES = ['Firefox Developer Edition.app', 'Firefox Nightly.app'];

export function resolveFirefoxApp(appPath?: string): FirefoxAppConfig | undefined {
  if (process.platform !== 'darwin') return undefined;

  const envPath = process.env.ORACLE_FIREFOX_APP;
  const rawPath = appPath ?? envPath;
  if (rawPath) {
    const source: FirefoxAppConfig['source'] = appPath ? 'cli' : 'env';
    return validateFirefoxAppPath(rawPath, source);
  }

  const app = findDefaultFirefoxApp();
  if (app) {
    return { ...app, source: 'auto' };
  }

  throw new Error(
    'Firefox Developer Edition or Firefox Nightly is required on macOS for automation isolation. Install one, or pass --firefox-app /Applications/Firefox\\ Developer\\ Edition.app (or set ORACLE_FIREFOX_APP).',
  );
}

function findDefaultFirefoxApp(): Omit<FirefoxAppConfig, 'source'> | undefined {
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
  for (const root of roots) {
    for (const name of DEFAULT_APP_NAMES) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) {
        return buildFirefoxAppConfig(candidate);
      }
    }
  }
  return undefined;
}

function validateFirefoxAppPath(rawPath: string, source: FirefoxAppConfig['source']): FirefoxAppConfig {
  const normalized = normalizeFirefoxAppPath(rawPath);
  if (!normalized) {
    throw new Error(`Invalid Firefox app path: ${rawPath}`);
  }
  if (!fs.existsSync(normalized.appPath)) {
    throw new Error(`Firefox app not found at ${normalized.appPath}`);
  }
  if (!fs.existsSync(normalized.executablePath)) {
    throw new Error(`Firefox executable missing at ${normalized.executablePath}`);
  }
  return { ...normalized, source };
}

function buildFirefoxAppConfig(appPath: string): Omit<FirefoxAppConfig, 'source'> {
  const appName = path.basename(appPath, '.app');
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'firefox');
  return { appPath, appName, executablePath };
}

export function normalizeFirefoxAppPath(rawPath: string): Omit<FirefoxAppConfig, 'source'> | null {
  const resolved = path.resolve(rawPath);
  const segments = resolved.split(path.sep);
  const appIndex = segments.findIndex((segment) => segment.endsWith('.app'));
  if (appIndex < 0) return null;
  const appPath = segments.slice(0, appIndex + 1).join(path.sep);
  return buildFirefoxAppConfig(appPath);
}

export const __test__ = {
  normalizeFirefoxAppPath,
};
