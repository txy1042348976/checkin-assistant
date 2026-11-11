import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './types.js';

function positiveEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, maximum: number): number {
  const raw = env[key] ?? String(fallback);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${key} 必须是有效整数。`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${key} 必须介于 1 与 ${maximum} 之间。`);
  return value;
}

export function detectBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.CHECKIN_BROWSER_PATH || env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root!, 'Google/Chrome/Application/chrome.exe'))
      : ['/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
  return candidates.find(candidate => existsSync(candidate));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<AppConfig> = {}): AppConfig {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const timezone = env.CHECKIN_TIMEZONE?.trim() || 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new Error('CHECKIN_TIMEZONE 必须是有效的 IANA 时区，例如 Asia/Shanghai。'); }
  const config: AppConfig = {
    dataDir: path.resolve(env.CHECKIN_DATA_DIR || path.join(root, 'data')),
    resourceRoot: root,
    host: env.CHECKIN_HOST || '0.0.0.0',
    port: positiveEnv(env, 'CHECKIN_PORT', 8765, 65535),
    timezone,
    publicUrl: (env.CHECKIN_PUBLIC_URL || '').trim().replace(/\/+$/, ''),
    trustedProxies: (env.CHECKIN_TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(value => value.trim()).filter(Boolean),
    maxConcurrentRuns: positiveEnv(env, 'CHECKIN_MAX_CONCURRENT_RUNS', 1, 8),
    sessionHours: positiveEnv(env, 'CHECKIN_SESSION_HOURS', 24, 720),
    loginMaxAttempts: positiveEnv(env, 'CHECKIN_LOGIN_MAX_ATTEMPTS', 8, 100),
    loginWindowSeconds: positiveEnv(env, 'CHECKIN_LOGIN_WINDOW_SECONDS', 600, 86400),
    loginGlobalMaxAttempts: positiveEnv(env, 'CHECKIN_LOGIN_GLOBAL_MAX_ATTEMPTS', 60, 1000),
    adminUser: env.CHECKIN_ADMIN_USER || 'admin',
    adminPassword: env.CHECKIN_ADMIN_PASSWORD || undefined,
    browserPath: detectBrowser(env),
    browserNoSandbox: ['1', 'true', 'yes'].includes((env.CHECKIN_BROWSER_NO_SANDBOX || '').toLowerCase()),
    lowMemory: ['1', 'true', 'yes'].includes((env.CHECKIN_LOW_MEMORY || '').toLowerCase()),
    defaultProxyUrl: env.CHECKIN_PROXY_URL || undefined,
    schedulerTickMs: 15_000,
    version: '1.0.9',
    testMode: false,
  };
  return { ...config, ...overrides };
}
