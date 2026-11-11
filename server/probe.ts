/** Read-only gateway detection, independent of any account or chosen protocol. */
import type { Browser } from 'playwright-core';
import type { BrowserResources } from './browser-resources.js';
import { loadConfig } from './config.js';
import { browserAvailable } from './engine.js';
import { isRecord } from './errors.js';
import { normalizeProviderDomain, parseProviderInput } from './providers.js';
import { httpRequest } from './transport.js';
import type { AppConfig, ProviderInput } from './types.js';

export const PUBLIC_PATHS = ['/api/status', '/api/v1/settings/public'] as const;
export interface ProbeResult {
  recognized: boolean;
  protocol?: 'newapi' | 'sub2api';
  template?: 'newapi' | 'sign_in' | 'balance' | 'sub2api';
  checkin_enabled?: boolean | null;
  defaults?: Pick<ProviderInput, 'login_path' | 'login_api_path' | 'user_info_path' | 'sign_in_path' | 'api_user_key' | 'quota_per_unit'>;
  message: string;
}
const UNKNOWN: ProbeResult = { recognized: false, message: '未能自动识别网站，请手动选择签到模式；也可以稍后重新检测。' };

export function classifyConfig(domain: string, path: string, body: unknown, legacyHint = false): ProbeResult | null {
  if (!isRecord(body) || !isRecord(body.data)) return null;
  const config = body.data;
  let protocol: 'newapi' | 'sub2api', template: NonNullable<ProbeResult['template']>, enabled: unknown;
  if (path === '/api/status' && body.success === true && typeof config.system_name === 'string') {
    protocol = 'newapi'; enabled = config.checkin_enabled;
    const legacy = config.sign_in_enabled === true || config.sign_in_path === '/api/user/sign_in' || legacyHint;
    template = enabled === true ? 'newapi' : legacy ? 'sign_in' : enabled === false ? 'balance' : 'newapi';
  } else if (path === '/api/v1/settings/public' && typeof body.code === 'number' && body.code === 0 && typeof config.site_name === 'string'
    && ['linuxdo_oauth_enabled', 'registration_enabled', 'check_in_enabled'].some(key => Object.hasOwn(config, key))) {
    protocol = 'sub2api'; enabled = config.check_in_enabled; template = enabled === false ? 'balance' : 'sub2api';
  } else return null;
  const input = parseProviderInput({ name: '探测', domain, template: protocol === 'sub2api' && template === 'balance' ? 'sub2api_balance' : template });
  const unit = config.quota_per_unit;
  if (protocol === 'newapi' && typeof unit === 'number' && Number.isFinite(unit) && unit >= 1 && unit <= 1e12) input.quota_per_unit = unit;
  const { login_path, login_api_path, user_info_path, sign_in_path, api_user_key, quota_per_unit } = input;
  const name = { newapi: '标准 New API 签到', sub2api: 'Sub2API 签到', sign_in: 'AnyRouter 兼容签到', balance: '仅同步余额' }[template];
  const note = enabled === false && template === 'balance' ? '站点已关闭签到。' : enabled === true ? '已读取到站点开放签到的配置。' : '签到能力将在登录后验证。';
  return { recognized: true, protocol, template, checkin_enabled: typeof enabled === 'boolean' ? enabled : null,
    defaults: { login_path, login_api_path, user_info_path, sign_in_path, api_user_key, quota_per_unit }, message: `已识别为${name}。${note}` };
}

export function chooseProbeResult(results: (ProbeResult | null | undefined)[]): ProbeResult | null {
  const matches = results.filter((result): result is ProbeResult => Boolean(result?.recognized));
  if (new Set(matches.map(result => result.protocol)).size > 1) return { recognized: false, message: '此网址提供多种接口类型，请手动选择要使用的签到模式。' };
  return matches[0] ?? null;
}

let probeBusy = false;
async function browserConfig(domain: string, config: AppConfig, options: ProbeOptions): Promise<(ProbeResult | null)[]> {
  if (probeBusy || !config.browserPath) return [];
  probeBusy = true;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let browser: Browser | undefined, closing: Promise<void> | undefined, stopped = false, release: (() => void) | undefined;
  const releaseBrowser = () => { release?.(); release = undefined; };
  const closeBrowser = async (current: Browser): Promise<void> => {
    try { await current.close(); releaseBrowser(); }
    catch {
      if (!current.isConnected()) releaseBrowser();
      else {
        current.once('disconnected', releaseBrowser);
        if (!current.isConnected()) { current.off('disconnected', releaseBrowser); releaseBrowser(); }
      }
    }
  };
  const stop = (): Promise<void> => {
    stopped = true; controller.abort();
    if (!closing && browser) closing = closeBrowser(browser);
    return closing ?? Promise.resolve();
  };
  const cancelled = () => { void stop(); };
  signal.addEventListener('abort', cancelled, { once: true });
  const timer = setTimeout(() => { void stop(); }, 20000); timer.unref();
  try {
    if (signal.aborted) return [];
    if (config.lowMemory && options.browserResources) release = await options.browserResources.acquire(signal);
    if (signal.aborted) return [];
    const { chromium } = await import('playwright-core');
    if (signal.aborted) return [];
    browser = await chromium.launch({ headless: true, executablePath: config.browserPath, timeout: 12_000,
      args: ['--no-proxy-server', ...(config.browserNoSandbox ? ['--no-sandbox'] : [])] });
    if (stopped) { await stop(); return []; }
    const context = await browser.newContext({ serviceWorkers: 'block' });
    if (stopped) return [];
    await context.route('**/*', async route => {
      const request = route.request(), target = new URL(request.url());
      const sameSite = target.origin === domain;
      if (stopped || request.isNavigationRequest() && !sameSite || !['GET', 'HEAD'].includes(request.method()) && !(sameSite && target.pathname.startsWith('/cdn-cgi/'))
        || sameSite && /^\/api\/(?:user|oauth|v1\/(?:auth|user))(?:\/|$)/.test(target.pathname)) await route.abort();
      else await route.fallback();
    });
    if (stopped) return [];
    const page = await context.newPage();
    if (stopped) return [];
    await page.goto(domain + '/login', { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (stopped || new URL(page.url()).origin !== domain) return [];
    try {
      await page.waitForFunction(() => {
        if ((window as unknown as { __APP_CONFIG__?: { site_name?: unknown } }).__APP_CONFIG__?.site_name) return true;
        try { return Boolean(JSON.parse(localStorage.getItem('status') || '{}').system_name); } catch { return false; }
      }, undefined, { timeout: config.testMode ? 100 : 4000 });
    } catch {}
    if (stopped) return [];
    const data = await page.evaluate<{ responses: unknown[]; legacy: boolean } | null, string>(String.raw`async expectedOrigin => {
      if (location.origin !== expectedOrigin) return null;
      const read = async (url, timeout, limit, json) => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
        try {
          const target = new URL(url, expectedOrigin);
          if (target.origin !== expectedOrigin) return null;
          const response = await fetch(target.href, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
          if (response.status !== 200 || json && !/application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) return null;
          const chunks = [], reader = response.body?.getReader(); let size = 0;
          if (reader) while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > limit) { await reader.cancel(); return null; }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const text = new TextDecoder().decode(bytes);
          return json ? JSON.parse(text) : text;
        } catch { return null; } finally { clearTimeout(timer); }
      };
      let status = null;
      try { status = JSON.parse(localStorage.getItem('status') || 'null'); } catch {}
      const settings = window.__APP_CONFIG__ ?? null;
      const responses = await Promise.all([
        status ? Promise.resolve({ success: true, data: status }) : read('/api/status', 4000, 262144, true),
        settings ? Promise.resolve({ code: 0, data: settings }) : read('/api/v1/settings/public', 4000, 262144, true),
      ]);
      let legacy = false;
      const statusBody = responses[0];
      if (statusBody?.success === true && statusBody.data?.checkin_enabled !== true) {
        const scripts = [...document.scripts].map(script => script.src).filter(src => {
          try { return Boolean(src) && new URL(src).origin === expectedOrigin; } catch { return false; }
        }).slice(0, 3);
        for (const src of scripts) {
          const text = await read(src, 2500, 4 * 1024 * 1024, false);
          if (typeof text === 'string' && /[\x27\x22\x60]\/(?:api\/)?user\/sign_in[\x27\x22\x60]/.test(text)) { legacy = true; break; }
        }
      }
      return location.origin === expectedOrigin ? { responses, legacy } : null;
    }`, domain);
    if (stopped || !data) return [];
    return PUBLIC_PATHS.map((path, index) => classifyConfig(domain, path, data.responses[index], data.legacy));
  } catch { return []; }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancelled);
    await stop();
    if (!browser) releaseBrowser();
    probeBusy = false;
  }
}

export interface ProbeOptions { signal?: AbortSignal; browserResources?: BrowserResources }
export async function probeSite(domainInput: string, configInput?: AppConfig, options: ProbeOptions = {}): Promise<ProbeResult> {
  const domain = normalizeProviderDomain(domainInput), config = configInput ?? loadConfig();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000);
  const direct = await Promise.all(PUBLIC_PATHS.map(async path => {
    try {
      const response = await httpRequest(domain + path, { method: 'GET', proxy: { mode: 'direct' }, signal, timeoutMs: 6000, maxBytes: 262144 });
      return response.status === 200 ? classifyConfig(domain, path, response.body) : null;
    } catch { return null; }
  }));
  if (options.signal?.aborted) return { ...UNKNOWN };
  const result = chooseProbeResult(direct);
  if (result && (!result.recognized || result.protocol === 'sub2api' || result.checkin_enabled !== null || result.template === 'sign_in')) return result;
  if (browserAvailable(config)) {
    const detected = chooseProbeResult(await browserConfig(domain, config, options));
    if (detected) return detected;
  }
  return result ?? { ...UNKNOWN };
}
