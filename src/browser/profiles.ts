import fs from 'fs';
import os from 'os';
import path from 'path';

export type ChromeProfileInfo = { dir: string; name: string };
export type FirefoxProfileInfo = { dir: string; name: string; path: string };

export function chromeUserDataDirMac(): string {
  return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
}

export function oracleChromeDataDir(): string {
  return path.join(os.homedir(), '.oracle', 'chrome');
}

export function listChromeProfilesMac(userDataDir: string = chromeUserDataDirMac()): ChromeProfileInfo[] {
  const localStatePath = path.join(userDataDir, 'Local State');
  const raw = fs.readFileSync(localStatePath, 'utf8');
  const json = JSON.parse(raw);
  const info = json.profile?.info_cache ?? {};
  return Object.entries(info).map(([dir, meta]) => {
    const metaName = (meta as { name?: string }).name;
    const name = typeof metaName === 'string' ? metaName : dir;
    return { dir, name };
  });
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
