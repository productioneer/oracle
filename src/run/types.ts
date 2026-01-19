import type { FocusStatus } from '../browser/focus.js';
import type { FirefoxAppConfig } from '../browser/firefox-app.js';

export type BrowserType = 'chrome' | 'firefox';

export type RunState =
  | 'starting'
  | 'running'
  | 'needs_user'
  | 'completed'
  | 'failed'
  | 'canceled';

export type RunStage =
  | 'init'
  | 'launch'
  | 'login'
  | 'navigate'
  | 'submit'
  | 'waiting'
  | 'extract'
  | 'recovery'
  | 'cleanup';

export type ProfileConfig = {
  kind: 'chrome' | 'firefox';
  userDataDir: string;
  profileDir?: string;
};

export type RunConfig = {
  runId: string;
  createdAt: string;
  prompt: string;
  promptHash: string;
  browser: BrowserType;
  profile: ProfileConfig;
  headless: false;
  baseUrl: string;
  allowVisible: boolean;
  allowKill: boolean;
  pollMs: number;
  timeoutMs: number;
  thinking: 'standard' | 'extended';
  debugPort?: number;
  browserPid?: number;
  conversationUrl?: string;
  lastAssistantIndex?: number;
  modelHint?: string;
  firefoxApp?: FirefoxAppConfig;
  attempt: number;
  maxAttempts: number;
  outDir: string;
  statusPath: string;
  resultPath: string;
  resultJsonPath: string;
  logPath: string;
  runPath: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  focus?: FocusStatus;
  focusOnly?: boolean;
};

export type StatusPayload = {
  runId: string;
  state: RunState;
  stage: RunStage;
  message?: string;
  updatedAt: string;
  attempt: number;
  conversationUrl?: string;
  needs?: {
    type: 'login' | 'cloudflare' | 'kill_chrome' | 'profile' | 'firefox_app' | 'unknown';
    details?: string;
  };
  focus?: FocusStatus;
};

export type ResultPayload = {
  runId: string;
  state: 'completed' | 'failed' | 'canceled';
  completedAt: string;
  conversationUrl?: string;
  content?: string;
  error?: string;
};
