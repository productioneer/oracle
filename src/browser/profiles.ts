import fs from 'fs';
import os from 'os';
import path from 'path';

export type FirefoxProfileInfo = { dir: string; name: string; path: string };

export function oracleChromeDataDir(): string {
  return path.join(os.homedir(), '.oracle', 'chrome');
}

export function oracleFirefoxDataDir(): string {
  return path.join(os.homedir(), '.oracle', 'firefox');
}

export function firefoxProfilesMac(): FirefoxProfileInfo[] {
  const iniPath = path.join(os.homedir(), 'Library/Application Support/Firefox/profiles.ini');
  if (!fs.existsSync(iniPath)) return [];
  const raw = fs.readFileSync(iniPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const profiles: FirefoxProfileInfo[] = [];
  let current: Partial<FirefoxProfileInfo> & { isRelative?: string } = {};
  for (const line of lines) {
    if (line.startsWith('[')) {
      if (current.name && current.dir) {
        profiles.push({
          name: current.name,
          dir: current.dir,
          path: current.path ?? current.dir,
        });
      }
      current = {};
      continue;
    }
    const [key, value] = line.split('=', 2);
    if (!key || value === undefined) continue;
    if (key === 'Name') current.name = value.trim();
    if (key === 'Path') {
      current.dir = value.trim();
      current.path = current.dir;
    }
    if (key === 'IsRelative') current.isRelative = value.trim();
  }
  if (current.name && current.dir) {
    profiles.push({
      name: current.name,
      dir: current.dir,
      path: current.path ?? current.dir,
    });
  }
  return profiles.map((profile) => {
    if (profile.dir.startsWith('/') || profile.dir.startsWith('~')) return profile;
    const base = path.join(os.homedir(), 'Library/Application Support/Firefox');
    return { ...profile, path: path.join(base, profile.dir) };
  });
}
