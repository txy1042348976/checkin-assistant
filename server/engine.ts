/** Browsers use temporary, account-owned contexts; secrets remain in encrypted storage. */
import { createHash, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page, Request, Response, Route } from 'playwright-core';
import { detectBrowser, loadConfig } from './config.js';
import { isRecord } from './errors.js';
import { isSub2API, profileId, profileSnapshot, resolveCustomProtocol, responseData, roundAmount, ProtocolMismatch } from './protocols.js';
import type { ProtocolStore } from './protocols.js';
import { PROVIDERS } from './providers.js';
import { browserProxy, proxyFailureMessage, resolveProxy } from './proxy.js';
import type { ResolvedProxy } from './proxy.js';
import { guardedResponse, httpRequest, isJsonContentType, safeRequestUrl, TransportError } from './transport.js';
import type { HttpResponse } from './transport.js';
import type { AccountRow, AppConfig, CookieData, Credentials, Profile, Provider, RunResult, Snapshot } from './types.js';

const RETRY_DELAYS = [2000, 5000];
const READ_BYTES = 512 * 1024;
const SAFE_SECRET = /^[\x21-\x7e]{1,32000}$/;
const OAUTH_LABELS = {
  github: /^(?:(?:使用|通过|用)\s*|(?:Sign in|Log in|Continue|Login)\s+(?:with|via)\s+)?GitHub(?:\s*(?:登录|授权))?$/i,
  linuxdo: /^(?:(?:使用|通过|用)\s*|(?:Sign in|Log in|Continue|Login)\s+(?:with|via)\s+)?Linux\s*\.?\s*do(?:\s*(?:登录|授权))?$/i,
};
type OAuthMethod = keyof typeof OAUTH_LABELS;
type SiteReply = HttpResponse & { url?: string };

function secret(value: unknown): value is string { return typeof value === 'string' && SAFE_SECRET.test(value) && !/[;,]/.test(value); }
function transientStatus(status: number): boolean { return status === 408 || status >= 500 && status <= 599; }
function transientError(error: unknown): boolean {
  return error instanceof TransportError && error.kind !== 'aborted' && error.kind !== 'limit'
    || error instanceof Error && (error.name === 'TimeoutError' || /net::ERR_(?:CONNECTION_|NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|TIMED_OUT|EMPTY_RESPONSE|ABORTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED)|Execution context was destroyed|Failed to fetch|Target page, context or browser has been closed/.test(error.message));
}
function origin(value: string): string { try { return new URL(value).origin; } catch { return ''; } }
function aborted(signal: AbortSignal): void { if (signal.aborted) throw new TransportError('aborted'); }
async function delay(ms: number, signal: AbortSignal, testMode = false): Promise<void> {
  aborted(signal);
  if (testMode) { await Promise.resolve(); aborted(signal); return; }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new TransportError('aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function browserAvailable(config?: Pick<AppConfig, 'browserPath'>): boolean { return Boolean(config?.browserPath ?? detectBrowser()); }

/** Drop incompatible, expired and partitioned cookies instead of broadening their scope. */
export function scopedCookies(items: unknown, options: { host?: string; names?: string[]; method?: string }): CookieData[] {
  if (!Array.isArray(items)) return [];
  const root = options.method === 'github' ? 'github.com' : options.method === 'linuxdo' ? 'linux.do' : null;
  const result: CookieData[] = [], seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item) || 'partitionKey' in item || '_crHasCrossSiteAncestor' in item || item.partitioned === true) continue;
    const { name, value, domain } = item;
    const cookiePath = item.path ?? '/', expires = item.expires ?? item.expirationDate ?? -1;
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]{1,128}$/.test(name) || !secret(value)
      || typeof domain !== 'string' || typeof cookiePath !== 'string' || !cookiePath.startsWith('/') || cookiePath.length > 1024
      || /[^\x20-\x7e]/.test(cookiePath) || typeof expires !== 'number' || !Number.isFinite(expires) || expires > 0 && expires <= Date.now() / 1000) continue;
    const host = domain.replace(/^\./, '').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.includes('..') || options.host !== undefined && host !== options.host
      || options.names && !options.names.includes(name) || options.method && (!root || host !== root && !host.endsWith('.' + root))) continue;
    let sameSite = item.sameSite;
    if (sameSite === 'no_restriction') sameSite = 'None';
    if (sameSite === 'lax') sameSite = 'Lax';
    if (sameSite === 'strict') sameSite = 'Strict';
    if (sameSite === 'unspecified' || sameSite === null) sameSite = undefined;
    if (sameSite !== undefined && sameSite !== 'Strict' && sameSite !== 'Lax' && sameSite !== 'None') continue;
    if (['httpOnly', 'secure'].some(key => item[key] !== undefined && typeof item[key] !== 'boolean') || sameSite === 'None' && item.secure !== true) continue;
    const key = `${name}\0${host}\0${cookiePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, value, domain: (domain.startsWith('.') ? '.' : '') + host, path: cookiePath,
      expires: expires > 0 ? expires : -1, ...(item.secure !== undefined ? { secure: item.secure as boolean } : {}),
      ...(item.httpOnly !== undefined ? { httpOnly: item.httpOnly as boolean } : {}), ...(sameSite ? { sameSite } : {}) });
  }
  return result;
}

function cookieApplies(cookie: CookieData, target: URL): boolean {
  const host = cookie.domain.replace(/^\./, '').toLowerCase();
  const path = cookie.path || '/';
  return host === target.hostname && (!cookie.secure || target.protocol === 'https:')
    && (!cookie.expires || cookie.expires <= 0 || cookie.expires > Date.now() / 1000)
    && (target.pathname === path || target.pathname.startsWith(path.endsWith('/') ? path : path + '/'));
}
function selectedSession(cookies: CookieData[], provider: Provider): string | null {
  const target = new URL(provider.user_info_path, provider.domain);
  return cookies.filter(cookie => cookie.name === 'session' && secret(cookie.value) && cookieApplies(cookie, target))
    .sort((left, right) => right.path.length - left.path.length)[0]?.value ?? null;
}
function issuedSession(values: string[], current: string): boolean {
  return values.some(value => /^session=([^;]*)/i.exec(value.trim())?.[1]?.replace(/^"|"$/g, '') === current);
}
function parseSetCookies(value: string | undefined, provider: Provider): CookieData[] {
  const target = new URL(provider.domain), result: CookieData[] = [];
  for (const line of value?.split('\n') ?? []) {
    const parts = line.split(';'), pair = parts.shift()?.trim() ?? '', separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator), rawValue = pair.slice(separator + 1).replace(/^"|"$/g, '');
    const cookie: CookieData = { name, value: rawValue, domain: target.hostname, path: '/', expires: -1 };
    for (const attr of parts) {
      const [key, ...rest] = attr.trim().split('='), content = rest.join('=');
      switch (key.toLowerCase()) {
        case 'domain': cookie.domain = content.toLowerCase(); break;
        case 'path': cookie.path = content; break;
        case 'expires': cookie.expires = Date.parse(content) / 1000; break;
        case 'max-age': if (/^-?\d+$/.test(content)) cookie.expires = Date.now() / 1000 + Number(content); break;
        case 'httponly': cookie.httpOnly = true; break;
        case 'secure': cookie.secure = true; break;
        case 'samesite': cookie.sameSite = ({ lax: 'Lax', strict: 'Strict', none: 'None' } as const)[content.toLowerCase() as 'lax' | 'strict' | 'none']; break;
        case 'partitioned': cookie.expires = 0; cookie.value = ''; break;
      }
    }
    if (cookie.value === '' || cookie.expires !== undefined && cookie.expires > -1 && cookie.expires <= Date.now() / 1000) {
      if (cookie.domain.replace(/^\./, '') === target.hostname) result.push({ ...cookie, value: '' });
    } else result.push(...scopedCookies([cookie], { host: target.hostname }));
  }
  return result;
}

interface JobClient {
  provider: Provider;
  token?: string;
  request(path: string, user: string | null, method?: string, payload?: unknown, auth?: boolean): Promise<SiteReply>;
  session(): Promise<string | null>;
  siteCookies(): Promise<CookieData[]>;
}

class HttpJobClient implements JobClient {
  token?: string;
  private cookies: CookieData[];
  constructor(public provider: Provider, credentials: Credentials, private proxy: ResolvedProxy | null,
    private config: AppConfig, private signal: AbortSignal) {
    this.token = isSub2API(provider) ? credentials.session : undefined;
    this.cookies = scopedCookies(credentials.site_cookies, { host: new URL(provider.domain).hostname, names: provider.waf_cookie_names });
    if (!isSub2API(provider) && secret(credentials.session)) this.cookies.push({ name: 'session', value: credentials.session, domain: new URL(provider.domain).hostname, path: '/' });
  }
  async request(path: string, user: string | null, method = 'GET', payload?: unknown, auth = true): Promise<SiteReply> {
    aborted(this.signal);
    const target = safeRequestUrl(new URL(path, this.provider.domain).href, this.provider);
    target.searchParams.set('_checkin_assistant_req', randomBytes(12).toString('base64url'));
    const headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest', referer: this.provider.domain + this.provider.login_path };
    const cookies = this.cookies.filter(cookie => (auth || cookie.name !== 'session') && cookieApplies(cookie, target));
    if (cookies.length) headers.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    if (auth && isSub2API(this.provider) && this.token) { headers.authorization = `Bearer ${this.token}`; headers['x-user-ui-request'] = '1'; }
    else if (auth && user !== null) headers[this.provider.api_user_key] = user;
    const reply = await httpRequest(target.href, { method, json: payload, headers, provider: this.provider, proxy: this.proxy,
      config: this.config, signal: this.signal, maxBytes: READ_BYTES });
    aborted(this.signal);
    for (const cookie of parseSetCookies(reply.headers['set-cookie'], this.provider)) {
      this.cookies = this.cookies.filter(previous => previous.name !== cookie.name || previous.domain !== cookie.domain || previous.path !== cookie.path);
      if (cookie.value) this.cookies.push(cookie);
    }
    return { ...reply, url: target.href };
  }
  async session(): Promise<string | null> { return isSub2API(this.provider) ? this.token ?? null : selectedSession(this.cookies, this.provider); }
  async siteCookies(): Promise<CookieData[]> { return scopedCookies(this.cookies, { host: new URL(this.provider.domain).hostname, names: this.provider.waf_cookie_names }); }
}

class PreflightError extends Error {
  constructor(public status: number, public manual = false, public retryable = transientStatus(status)) { super('站点准备阶段未完成。'); }
}
interface OAuthState {
  method: OAuthMethod;
  clientId: string;
  state?: string;
  entryStarted: boolean;
  entryRequest: boolean;
  stateRequest: boolean;
  authorizationSeen: boolean;
  callbackDocument: boolean;
  callbackRequest: boolean;
  approvalClicked: boolean;
  approvalPermit?: { url: string; method: string };
  submitted: boolean;
}

/** A headless same-origin transport; it never opens or attaches to a user's browser. */
export class BrowserSession implements JobClient {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  token?: string;
  oauth?: OAuthState;
  private launchTask?: Promise<Browser>;
  private closing?: Promise<void>;
  private stopping = false;
  private browserClosed = false;
  private permits = new Map<string, string>();
  private navigationBarrier?: Promise<void>;
  private installedLoginCapture?: OAuthMethod;
  private loginBinding = '__checkinLoginRead_' + randomBytes(12).toString('hex');
  private lastRequest = 0;
  private ownAbort = new AbortController();
  readonly signal: AbortSignal;
  constructor(public provider: Provider, private config: AppConfig, private proxy: ResolvedProxy | null, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.ownAbort.signal]);
  }
  private check(): void { aborted(this.signal); if (this.stopping) throw new TransportError('aborted'); }
  private async closeBrowser(browser: Browser): Promise<void> {
    if (this.browserClosed) return;
    this.browserClosed = true;
    try { await browser.close(); } catch {}
  }
  async start(credentials: Credentials, upstream: CookieData[] = []): Promise<void> {
    this.check();
    if (!this.config.browserPath) throw new PreflightError(0, true, false);
    this.launchTask = chromium.launch({ headless: true, executablePath: this.config.browserPath, timeout: 20_000,
      args: [...(this.proxy ? [] : ['--no-proxy-server']), ...(this.config.browserNoSandbox ? ['--no-sandbox'] : [])] });
    const browser = await this.launchTask;
    this.browser = browser;
    if (this.stopping || this.signal.aborted) { await this.closeBrowser(browser); this.check(); }
    this.context = await browser.newContext({ serviceWorkers: 'block', proxy: browserProxy(this.proxy),
      ...(typeof credentials.oauth_user_agent === 'string' && /^[\x20-\x7e]{1,1000}$/.test(credentials.oauth_user_agent) ? { userAgent: credentials.oauth_user_agent } : {}) });
    this.check();
    this.context.on('request', request => {
      // Redirected requests may bypass a Playwright route handler. Record the
      // submission boundary when Chromium emits the request, before any result.
      const oauth = this.oauth;
      if (!oauth?.entryStarted) return;
      try {
        const url = new URL(request.url());
        if (url.origin === origin(this.provider.domain) && (url.pathname === this.provider.login_api_path
          || [`/oauth/${oauth.method}`, `/api/oauth/${oauth.method}`, `/auth/${oauth.method}/callback`].includes(url.pathname) && url.searchParams.has('code'))) oauth.submitted = true;
      } catch {}
    });
    await this.context.route('**/*', route => this.route(route)); this.check();
    const site = scopedCookies(credentials.site_cookies, { host: new URL(this.provider.domain).hostname, names: this.provider.waf_cookie_names });
    if (site.length) { await this.context.addCookies(site); this.check(); }
    if (upstream.length) { await this.context.addCookies(upstream); this.check(); }
    this.page = await this.context.newPage(); this.check();
    // No account Session is present while the target issues its own WAF cookies.
    await this.navigate(this.provider.domain + (this.provider.name === 'agentrouter' ? this.provider.login_path : '/'));
    if (this.provider.waf_cookie_names.length) {
      for (let attempt = 0; attempt < (this.config.testMode ? 1 : 12); attempt++) {
        const cookies = await this.siteCookies(); this.check();
        const required = this.provider.waf_cookie_names;
        if (required.every(name => cookies.some(cookie => cookie.name === name && cookie.value))) break;
        if (attempt === (this.config.testMode ? 0 : 11)) throw new PreflightError(403, true, false);
        await delay(500, this.signal);
      }
    }
    if (isSub2API(this.provider)) this.token = credentials.session;
    else if (secret(credentials.session)) {
      await this.context.addCookies([{ name: 'session', value: credentials.session, domain: new URL(this.provider.domain).hostname, path: '/' }]); this.check();
    }
    if (this.provider.sign_in_path) await this.navigate(this.provider.domain + this.provider.login_path);
  }
  private async route(route: Route): Promise<void> {
    if (this.stopping || this.signal.aborted) { await route.abort().catch(() => {}); return; }
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const target = origin(this.provider.domain), isTarget = url.origin === target;
    if (this.navigationBarrier && this.oauth?.callbackRequest && isTarget && request.resourceType() === 'document') {
      // Preserve the OAuth response body until evidence has read it. Chromium
      // otherwise drops it when a fast SPA navigates immediately after login.
      const timeout = new AbortController();
      try { await Promise.race([this.navigationBarrier, delay(5000, AbortSignal.any([this.signal, timeout.signal]))]); }
      catch { await route.abort().catch(() => {}); return; }
      finally { timeout.abort(); }
      if (this.signal.aborted) { await route.abort().catch(() => {}); return; }
    }
    const key = `${method} ${url.href}`, permit = this.permits.get(key);
    if (permit) { this.permits.delete(key); await route.fallback(); return; }
    if (isTarget && url.pathname === this.provider.logout_path && this.provider.logout_path !== null) { await route.abort(); return; }
    const oauth = this.oauth;
    if (oauth?.entryStarted && isTarget && method === 'GET') {
      if (url.pathname === '/api/oauth/state' && !oauth.stateRequest && !oauth.submitted) { oauth.stateRequest = true; await route.fallback(); return; }
      const callbacks = [`/oauth/${oauth.method}`, `/api/oauth/${oauth.method}`, `/auth/${oauth.method}/callback`];
      if (callbacks.includes(url.pathname) && url.searchParams.has('code')) {
        const valid = oauth.authorizationSeen && Boolean(oauth.state) && url.searchParams.getAll('state').length === 1
          && url.searchParams.get('state') === oauth.state && url.searchParams.getAll('code').length === 1
          && Boolean(url.searchParams.get('code')) && (!url.searchParams.has('mode') || url.searchParams.get('mode') === 'login');
        const api = url.pathname === `/api/oauth/${oauth.method}`;
        if (valid && !(api ? oauth.callbackRequest : oauth.callbackDocument)) {
          if (api) oauth.callbackRequest = true; else oauth.callbackDocument = true;
          oauth.submitted = true; await route.fallback(); return;
        }
        await route.abort(); return;
      }
      if ([`/api/oauth/${oauth.method}`, `/oauth/${oauth.method}`, `/auth/${oauth.method}`, `/api/auth/${oauth.method}`, `/api/v1/auth/oauth/${oauth.method}/start`].includes(url.pathname)
        && !url.searchParams.has('code') && !url.searchParams.has('state') && !oauth.entryRequest && !oauth.authorizationSeen && !oauth.submitted) {
        oauth.entryRequest = true; await route.fallback(); return;
      }
    }
    if (oauth?.entryStarted && this.validAuthorize(url, oauth)) {
      if (method === 'GET' && request.isNavigationRequest() && !oauth.authorizationSeen && !oauth.submitted) {
        oauth.authorizationSeen = true; oauth.state = url.searchParams.get('state')!;
        await route.fallback(); return;
      }
      // The one official consent POST is separately permitted below.
    }
    if (oauth?.approvalPermit && key === `${oauth.approvalPermit.method} ${oauth.approvalPermit.url}`) {
      oauth.approvalPermit = undefined; oauth.submitted = true; await route.fallback(); return;
    }
    if (!['GET', 'HEAD'].includes(method)) {
      if (isTarget && url.pathname.startsWith('/cdn-cgi/')) await route.fallback(); else await route.abort();
      return;
    }
    if (isTarget && (/^\/api\/(?:user|oauth|v1\/auth|v1\/user)(?:\/|$)/.test(url.pathname)
      || url.pathname === this.provider.user_info_path || url.pathname === this.provider.sign_in_path || url.pathname === this.provider.login_api_path)) {
      await route.abort(); return;
    }
    if (request.isNavigationRequest() && !isTarget) {
      const root = oauth?.method === 'github' ? 'github.com' : oauth?.method === 'linuxdo' ? 'linux.do' : '';
      if (!oauth?.authorizationSeen || url.protocol !== 'https:' || url.port || !root || url.hostname !== root && !url.hostname.endsWith('.' + root)) {
        await route.abort(); return;
      }
    }
    await route.fallback();
  }
  validAuthorize(url: URL, oauth: OAuthState): boolean {
    const official = oauth.method === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://connect.linux.do/oauth2/authorize';
    const expected = new URL(official);
    const state = url.searchParams.get('state'), redirect = url.searchParams.get('redirect_uri');
    return url.origin === expected.origin && url.pathname === expected.pathname && !url.username && !url.password
      && url.searchParams.getAll('client_id').length === 1 && url.searchParams.get('client_id') === oauth.clientId
      && url.searchParams.getAll('state').length === 1 && Boolean(state && state.length <= 2048)
      && (!oauth.state || state === oauth.state) && !url.searchParams.has('code')
      && url.searchParams.getAll('redirect_uri').length <= 1 && (redirect === null || origin(redirect) === origin(this.provider.domain));
  }
  async navigate(url: string): Promise<void> {
    this.check();
    if (origin(url) !== origin(this.provider.domain)) throw new PreflightError(0, true, false);
    const response = await this.page!.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); this.check();
    if (response && response.status() !== 200 && (transientStatus(response.status()) || [401, 403, 429].includes(response.status()))) {
      throw new PreflightError(response.status(), !transientStatus(response.status()));
    }
    await this.settle();
    if (origin(this.page!.url()) !== origin(this.provider.domain)) throw new PreflightError(0, true, false);
  }
  async settle(): Promise<void> {
    this.check();
    try { await this.page?.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch { this.check(); }
    let previous = '', stable = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = this.page?.url() ?? '';
      stable = current === previous ? stable + 1 : 0; previous = current;
      if (stable >= 3) return;
      await delay(this.config.testMode ? 40 : 150, this.signal);
    }
  }
  async request(path: string, user: string | null, method = 'GET', payload?: unknown, auth = true): Promise<SiteReply> {
    this.check();
    if (!this.page || !this.context || origin(this.page.url()) !== origin(this.provider.domain)) throw new PreflightError(0, true, false);
    const target = safeRequestUrl(new URL(path, this.provider.domain).href, this.provider);
    target.searchParams.set('_checkin_assistant_req', randomBytes(12).toString('base64url'));
    await delay(Math.max(0, 1100 - (Date.now() - this.lastRequest)), this.signal, this.config.testMode);
    let cookieHeaders: Promise<string[]> | undefined;
    const observe = (response: Response) => {
      if (response.url() !== target.href || response.request().method() !== method) return;
      cookieHeaders = response.headersArray().then(headers => headers.filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value)).catch(() => []);
    };
    this.context.on('response', observe);
    this.permits.set(`${method} ${target.href}`, path);
    try {
      // This function is serialized into the page; no site config or arbitrary code is executed by the adapter.
      const reply = await this.page.evaluate(async options => {
        if (location.origin !== options.origin || new URL(options.url).origin !== options.origin) throw new Error('Unexpected origin');
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
        try {
          const headers: Record<string, string> = { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest', 'cache-control': 'no-cache' };
          if (options.auth && options.bearer && options.token) { headers.authorization = 'Bearer ' + options.token; headers['x-user-ui-request'] = '1'; }
          else if (options.auth && options.user !== null) headers[options.userHeader] = options.user;
          if (options.payload !== undefined) headers['content-type'] = 'application/json';
          const response = await fetch(options.url, { method: options.method, headers, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
            signal: controller.signal, ...(options.payload !== undefined ? { body: JSON.stringify(options.payload) } : {}) });
          const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
          if (reader) while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > options.maxBytes) { await reader.cancel(); throw new Error('Response limit'); }
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const text = new TextDecoder().decode(bytes), received: Record<string, string> = {};
          response.headers.forEach((value, key) => { received[key] = value; });
          let body: unknown = null;
          if (/application\/(?:[\w.-]+\+)?json\b/i.test(received['content-type'] ?? '')) { try { body = JSON.parse(text); } catch {} }
          return { status: response.status, url: response.url, headers: received, text, body };
        } finally { clearTimeout(timer); }
      }, { origin: origin(this.provider.domain), url: target.href, user, userHeader: this.provider.api_user_key, method, payload,
        auth, bearer: isSub2API(this.provider), token: this.token, maxBytes: READ_BYTES });
      this.check(); this.lastRequest = Date.now();
      if (reply.url !== target.href || origin(this.page.url()) !== origin(this.provider.domain)) throw new PreflightError(0, true, false);
      const values = await cookieHeaders; this.check();
      if (values?.length) reply.headers['set-cookie'] = values.join('\n');
      return reply;
    } finally { this.context.off('response', observe); this.permits.delete(`${method} ${target.href}`); }
  }
  async session(): Promise<string | null> {
    this.check();
    if (isSub2API(this.provider)) return this.token ?? null;
    const result = selectedSession(await this.context!.cookies([this.provider.domain + this.provider.user_info_path]), this.provider); this.check(); return result;
  }
  async siteCookies(): Promise<CookieData[]> {
    this.check();
    const cookies = await this.context!.cookies([this.provider.domain]); this.check();
    return scopedCookies(cookies, { host: new URL(this.provider.domain).hostname, names: this.provider.waf_cookie_names });
  }
  async prepareOAuth(method: OAuthMethod): Promise<OAuthState> {
    this.check();
    this.oauth = undefined; this.permits.clear();
    const host = new URL(this.provider.domain).hostname;
    await this.context!.clearCookies({ name: 'session', domain: new RegExp('^\\.?' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }); this.check();
    if (origin(this.page!.url()) === origin(this.provider.domain)) {
      await this.page!.evaluate(() => { localStorage.removeItem('user'); localStorage.removeItem('status'); sessionStorage.clear(); }); this.check();
    }
    for (const page of this.context!.pages()) if (page !== this.page) { await page.close(); this.check(); }
    await this.installLoginCapture(method); this.check();
    await this.navigate(this.provider.domain + this.provider.login_path);
    const response = await this.request('/api/status', null, 'GET', undefined, false);
    if (response.status !== 200) throw new PreflightError(response.status, !transientStatus(response.status));
    const status = responseData(response.body, this.provider), clientId = status?.[method + '_client_id'];
    if (guardedResponse(response) || typeof clientId !== 'string' || !clientId.trim() || /^(undefined|null)$/i.test(clientId.trim()) || clientId.length > 512) throw new PreflightError(0, true, false);
    const oauth: OAuthState = { method, clientId: clientId.trim(), entryStarted: false, entryRequest: false, stateRequest: false,
      authorizationSeen: false, callbackDocument: false, callbackRequest: false, approvalClicked: false, submitted: false };
    this.oauth = oauth; return oauth;
  }
  private async installLoginCapture(method: OAuthMethod): Promise<void> {
    if (this.installedLoginCapture === method) return;
    const path = '/api/oauth/' + method;
    await this.context!.exposeBinding(this.loginBinding, async (source, responseUrl: unknown) => {
      const oauth = this.oauth;
      if (!oauth?.callbackRequest || this.signal.aborted || typeof responseUrl !== 'string' || responseUrl.length > 4096
        || source.context !== this.context || origin(source.frame.url()) !== origin(this.provider.domain)) return;
      const url = new URL(responseUrl);
      if (url.origin !== origin(this.provider.domain) || url.pathname !== path || url.searchParams.get('state') !== oauth.state || !url.searchParams.get('code')) return;
      if (this.navigationBarrier) {
        const timeout = new AbortController();
        try { await Promise.race([this.navigationBarrier, delay(5000, AbortSignal.any([this.signal, timeout.signal]))]); }
        catch {} finally { timeout.abort(); }
      }
    }); this.check();
    // Only delay delivery of this login response to the SPA. Identity still
    // comes from the genuine Playwright Response, never from the page binding.
    // Use JavaScript source here so TSX cannot inject module-local helpers.
    await this.context!.addInitScript({ content: `(${String.raw`options => {
      if (location.origin !== options.origin) return;
      const match = value => {
        try { const url = new URL(value, location.href); return url.origin === options.origin && url.pathname === options.path && url.searchParams.has('code') && url.searchParams.has('state'); }
        catch (_) { return false; }
      };
      const wait = async value => {
        try { if (match(value)) await globalThis[options.binding](new URL(value, location.href).href); } catch (_) {}
      };
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = async function(...args) {
        const response = await nativeFetch.apply(this, args);
        if (match(response.url)) await wait(response.url);
        return response;
      };
      const proto = XMLHttpRequest.prototype, nativeOpen = proto.open;
      proto.open = function(method, url, ...args) {
        const xhr = this, target = String(url);
        const result = nativeOpen.call(this, method, url, ...args);
        if (match(target)) {
          let waiting = false, released = false;
          const events = [];
          const hold = event => {
            if (released || xhr.readyState !== 4) return;
            event.stopImmediatePropagation(); events.push(event.type);
            if (waiting) return;
            waiting = true;
            wait(xhr.responseURL || target).finally(() => {
              released = true;
              for (const type of events) xhr.dispatchEvent(new Event(type));
            });
          };
          for (const type of ['readystatechange', 'load', 'loadend']) xhr.addEventListener(type, hold, true);
        }
        return result;
      };
    }`})(${JSON.stringify({ origin: origin(this.provider.domain), path, binding: this.loginBinding })});` });
    this.check(); this.installedLoginCapture = method;
  }
  holdLoginNavigation(): () => void {
    let complete!: () => void;
    const barrier = new Promise<void>(resolve => { complete = resolve; });
    this.navigationBarrier = barrier;
    return () => { complete(); if (this.navigationBarrier === barrier) this.navigationBarrier = undefined; };
  }
  async openOAuth(oauth: OAuthState): Promise<boolean> {
    this.check();
    if (origin(this.page!.url()) !== origin(this.provider.domain)) return false;
    for (const role of ['button', 'link'] as const) {
      const candidates = this.page!.getByRole(role, { name: OAUTH_LABELS[oauth.method] });
      for (let index = 0; index < await candidates.count(); index++) {
        const candidate = candidates.nth(index);
        if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
        const info = await candidate.evaluate(element => {
          const control = element as HTMLButtonElement;
          const form = control.form;
          return { href: element.getAttribute('href'), submit: Boolean(form && control.type === 'submit'),
            formAction: form ? control.getAttribute('formaction') || form.action : '',
            formMethod: form ? (control.getAttribute('formmethod') || form.method).toLowerCase() : '',
            sensitiveForm: Boolean(form?.querySelector('input[type="password"],input[type="email"],input[name*="captcha" i],input[name*="otp" i]')) };
        }); this.check();
        const entryPaths = [`/api/oauth/${oauth.method}`, `/oauth/${oauth.method}`, `/auth/${oauth.method}`, `/api/auth/${oauth.method}`, `/api/v1/auth/oauth/${oauth.method}/start`];
        if (info.href) {
          const href = new URL(info.href, this.page!.url());
          const local = href.origin === origin(this.provider.domain) && entryPaths.includes(href.pathname) && !href.searchParams.has('code') && !href.searchParams.has('state');
          if (!local && !this.validAuthorize(href, oauth)) continue;
        }
        if (info.submit) {
          const action = new URL(info.formAction, this.page!.url());
          if (info.sensitiveForm || info.formMethod !== 'get' || action.origin !== origin(this.provider.domain) || !entryPaths.includes(action.pathname)) continue;
        }
        if (origin(this.page!.url()) !== origin(this.provider.domain)) return false;
        oauth.entryStarted = true;
        await candidate.click({ timeout: 6000 }); this.check(); return true;
      }
    }
    return false;
  }
  async approveOAuth(oauth: OAuthState): Promise<boolean> {
    this.check();
    if (oauth.approvalClicked || !oauth.authorizationSeen) return false;
    for (const page of this.context!.pages()) {
      const location = new URL(page.url());
      if (!this.validAuthorize(location, oauth)) continue;
      const matches = await page.evaluate(target => [...document.querySelectorAll('a[href]')].some(link => {
        try { return new URL((link as HTMLAnchorElement).href).origin === target; } catch { return false; }
      }), origin(this.provider.domain)); this.check();
      if (!matches) continue;
      const label = oauth.method === 'linuxdo' ? /^(允许|Allow)$/i : /^Authorize(?:\s+.+)?$/i;
      for (const role of ['link', 'button'] as const) {
        const controls = page.getByRole(role, { name: label });
        for (let index = 0; index < await controls.count(); index++) {
          const candidate = controls.nth(index);
          if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
          const info = await candidate.evaluate(element => {
            const control = element as HTMLButtonElement, form = control.form;
            return { href: element.getAttribute('href'), submit: Boolean(form && control.type === 'submit'),
              action: form ? control.getAttribute('formaction') || form.action : null,
              method: form ? (control.getAttribute('formmethod') || form.method).toUpperCase() : 'GET',
              sensitive: Boolean(form?.querySelector('input[type="password"],input[name*="captcha" i],input[name*="otp" i],input[name*="two_factor" i]')),
              client: (form?.querySelector('input[name="client_id"]') as HTMLInputElement | null)?.value ?? null,
              state: (form?.querySelector('input[name="state"]') as HTMLInputElement | null)?.value ?? null,
              redirect: (form?.querySelector('input[name="redirect_uri"]') as HTMLInputElement | null)?.value ?? null };
          }); this.check();
          if (!info.href && (!info.submit || !info.action) || info.sensitive || !['GET', 'POST'].includes(info.method)) continue;
          const action = new URL(info.href || info.action!, page.url());
          const official = oauth.method === 'linuxdo' ? 'https://connect.linux.do' : 'https://github.com';
          const validPath = oauth.method === 'linuxdo' ? action.pathname === '/oauth2/approve' || action.pathname.startsWith('/oauth2/approve/') : action.pathname === '/login/oauth/authorize';
          if (action.origin !== official || !validPath || info.client !== null && info.client !== oauth.clientId
            || info.state !== null && info.state !== oauth.state || info.redirect !== null && origin(info.redirect) !== origin(this.provider.domain)) continue;
          oauth.approvalClicked = true; oauth.approvalPermit = { url: action.href, method: info.href ? 'GET' : info.method };
          oauth.submitted = true;
          await candidate.click({ timeout: 6000 }); this.check(); return true;
        }
      }
    }
    return false;
  }
  async upstreamBlocked(method: OAuthMethod): Promise<boolean> {
    this.check();
    for (const page of this.context!.pages()) {
      const url = new URL(page.url()), root = method === 'github' ? 'github.com' : 'linux.do';
      if (url.hostname !== root && !url.hostname.endsWith('.' + root)) continue;
      if ((/^\/login(?:\/|$)/i.test(url.pathname) && url.pathname !== '/login/oauth/authorize')
        || /^\/(?:sessions?|two-factor|sudo|challenge|captcha)(?:\/|$)/i.test(url.pathname)) return true;
      if (await page.locator('input[type="password"]:visible,input[name*="captcha" i]:visible,input[name*="otp" i]:visible,iframe[src*="captcha" i]:visible').count()) return true;
      this.check();
    }
    return false;
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true; this.ownAbort.abort(); this.oauth = undefined;
    this.closing = (async () => {
      const browser = this.browser ?? await this.launchTask?.catch(() => undefined);
      if (browser) await this.closeBrowser(browser);
    })();
    return this.closing;
  }
}

interface FreshLogin { profile: Profile; session: string; received: number; page: Page }
class LoginEvidence {
  private sequence = 0;
  private latest?: FreshLogin;
  private tasks = new Set<Promise<void>>();
  private active = true;
  private observer: (response: Response) => void;
  private releaseNavigation: () => void;
  constructor(private client: BrowserSession, private oauth: OAuthState) {
    this.releaseNavigation = client.holdLoginNavigation();
    this.observer = response => {
      if (!this.active || !this.oauth.submitted || origin(response.url()) !== origin(this.client.provider.domain)
        || new URL(response.url()).pathname !== `/api/oauth/${oauth.method}`) return;
      const sequence = ++this.sequence; this.latest = undefined;
      const task = this.capture(response, sequence).finally(() => { this.tasks.delete(task); this.releaseNavigation(); });
      this.tasks.add(task); void task.catch(() => {});
    };
    client.context!.on('response', this.observer);
  }
  private async capture(response: Response, sequence: number): Promise<void> {
    try {
      const request = response.request(), url = new URL(request.url()), frame = request.frame(), page = frame.page();
      if (this.client.signal.aborted || response.status() !== 200 || response.fromServiceWorker() || page.context() !== this.client.context
        || !this.oauth.authorizationSeen || url.origin !== origin(this.client.provider.domain) || origin(frame.url()) !== origin(this.client.provider.domain)
        || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== this.oauth.state
        || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code') || url.searchParams.getAll('mode').length > 1
        || url.searchParams.has('mode') && url.searchParams.get('mode') !== 'login') return;
      // Begin reading immediately: the site's SPA may navigate as soon as it
      // consumes this response, after which Chromium can discard its body.
      const [headers, raw, headerList] = await Promise.all([response.allHeaders(), response.body(), response.headersArray()]);
      if (!isJsonContentType(headers['content-type'])) return;
      if (raw.length > READ_BYTES) return;
      const body: unknown = JSON.parse(raw.toString('utf8'));
      if (!isRecord(body) || body.success !== true || body.message === 'bind' || body.msg === 'bind') return;
      const data = responseData(body, this.client.provider), id = data ? profileId(data.id) : null;
      if (!data || !id) return;
      const session = await this.client.session();
      const issued = headerList.filter(header => header.name.toLowerCase() === 'set-cookie').map(header => header.value);
      if (!session || !issuedSession(issued, session) || !this.active || sequence !== this.sequence || this.client.signal.aborted) return;
      const profile: Profile = { id };
      if (typeof data.username === 'string') profile.username = data.username.slice(0, 100);
      if (typeof data.checked_in === 'boolean') profile.checked_in = data.checked_in;
      // Login quota/used values are placeholders; only a fresh self response supplies money.
      this.latest = { profile, session, received: Date.now(), page };
    } catch { /* Keep only allowlisted evidence, never raw login responses. */ }
  }
  async get(): Promise<FreshLogin | undefined> {
    const value = this.latest;
    if (!value || Date.now() - value.received > 120000 || value.page.isClosed() || origin(value.page.url()) !== origin(this.client.provider.domain)
      || value.session !== await this.client.session()) return undefined;
    return value;
  }
  async close(): Promise<void> {
    this.active = false; this.sequence++; this.latest = undefined;
    this.releaseNavigation();
    this.client.context?.off('response', this.observer);
    await Promise.allSettled([...this.tasks]);
  }
}

interface ProfileRead { response?: SiteReply; profile?: Profile; snapshot?: Snapshot; kind?: 'status' | 'waf' | 'identity' | 'money' | 'format' }
async function readProfile(client: JobClient, provider: Provider, id: string): Promise<ProfileRead> {
  const response = await client.request(provider.user_info_path, id);
  if (guardedResponse(response)) return { response, kind: 'waf' };
  if (response.status !== 200) return { response, kind: 'status' };
  const data = responseData(response.body, provider);
  if (!data) return { response, kind: 'format' };
  if (profileId(data.id) !== id) return { response, kind: 'identity' };
  const snapshot = profileSnapshot(data, provider);
  return snapshot ? { response, profile: data as Profile, snapshot } : { response, profile: data as Profile, kind: 'money' };
}

export function classifyCheckinResponse(provider: Provider, response: SiteReply): Pick<RunResult, 'status' | 'message' | 'reward'> {
  if (guardedResponse(response)) return { status: 'manual_required', message: '站点要求人工验证，请在自己的浏览器中处理后重试。' };
  if (response.status !== 200) return { status: [401, 403, 429].includes(response.status) ? 'manual_required' : 'failed', message: `站点返回 HTTP ${response.status}，尚未确认签到结果。` };
  const body = response.body;
  if (!isRecord(body)) return { status: 'failed', message: '签到接口返回内容无效，请检查接口配置或站点防护。' };
  const reason = body.reason ?? body.code;
  if (isSub2API(provider) && reason === 'CHECK_IN_ALREADY_DONE') return { status: 'already_checked', message: '站点确认今日已签到。', reward: 0 };
  if (isSub2API(provider) && ['CHECK_IN_CAPTCHA_REQUIRED', 'CHECK_IN_DISABLED'].includes(String(reason))) return { status: 'manual_required', message: '站点要求人工验证或尚未开放签到，请在官网处理。' };
  const message = typeof body.msg === 'string' ? body.msg : typeof body.message === 'string' ? body.message : '';
  if (/已经签到|已签到|重复签到|already checked|already signed/i.test(message)) return { status: 'already_checked', message: '站点确认今日已签到。', reward: 0 };
  const confirmed = isSub2API(provider) ? typeof body.code === 'number' && body.code === 0
    : body.success === true || provider.template === 'sign_in' && !Object.hasOwn(body, 'success') && (body.ret === 1 || body.code === 0);
  if (!confirmed) return { status: 'failed', message: '签到接口未明确确认成功，请检查签到路径、登录状态或站点兼容性。' };
  const data = responseData(body, provider), reward = data?.reward;
  return { status: 'success', message: '签到接口返回成功。', ...(isSub2API(provider) && typeof reward === 'number' && Number.isFinite(reward) && reward >= 0 ? { reward: roundAmount(reward) } : {}) };
}

export interface EngineOptions { providers?: Record<string, Provider>; config?: AppConfig; store?: ProtocolStore }
export class CheckinEngine {
  private providers: Record<string, Provider>;
  private config: AppConfig;
  private store?: ProtocolStore;
  private controllers = new Set<AbortController>();
  private jobs = new Set<Promise<RunResult>>();
  private browsers = new Set<BrowserSession>();
  private cache = new Map<number, { session: BrowserSession; signature: string; updated: number }>();
  private activeIds = new Set<number>();
  private stopping = false;
  private closeTask?: Promise<void>;
  constructor(options: EngineOptions = {}) {
    this.providers = options.providers ?? structuredClone(PROVIDERS); this.config = options.config ?? loadConfig(); this.store = options.store;
  }
  run(row: AccountRow, credentials: Credentials, hasSnapshot = Boolean(row.has_snapshot)): Promise<RunResult> {
    if (this.stopping) return Promise.resolve({ status: 'interrupted', message: '服务已停止，任务未执行。', duration_ms: 0 });
    if (this.activeIds.has(row.id)) return Promise.resolve({ status: 'failed', message: '此账号已有正在运行的任务。', duration_ms: 0 });
    const controller = new AbortController(); this.controllers.add(controller); this.activeIds.add(row.id);
    const task = this.execute(row, structuredClone(credentials), hasSnapshot, controller.signal).finally(() => {
      this.controllers.delete(controller); this.activeIds.delete(row.id); this.jobs.delete(task);
    });
    this.jobs.add(task); return task;
  }
  private signature(row: AccountRow, credentials: Credentials, provider: Provider): string {
    return createHash('sha256').update(JSON.stringify({ id: row.id, provider, method: row.login_via, user: credentials.api_user,
      session: credentials.session, cookies: credentials.oauth_cookies, ua: credentials.oauth_user_agent,
      proxy: resolveProxy(provider, credentials.proxy, this.config), browser: this.config.browserPath, noSandbox: this.config.browserNoSandbox })).digest('hex');
  }
  private async execute(row: AccountRow, credentials: Credentials, hasSnapshot: boolean, signal: AbortSignal): Promise<RunResult> {
    const start = Date.now();
    let attempts = 0, result: RunResult = { status: 'failed', message: '签到未完成。' };
    for (; attempts <= RETRY_DELAYS.length; attempts++) {
      try { aborted(signal); result = await this.runOnce(row, credentials, hasSnapshot, signal); }
      catch (error) { result = { status: signal.aborted ? 'interrupted' : 'failed', message: signal.aborted ? '服务停止，任务未完成。' : '任务未完成，请稍后重试。' }; }
      const retryable = result._retryable; delete result._retryable;
      if (!retryable || attempts === RETRY_DELAYS.length || signal.aborted) break;
      try { await delay(RETRY_DELAYS[attempts], signal, this.config.testMode); }
      catch { result = { status: 'interrupted', message: '服务停止，任务未完成。' }; break; }
    }
    if (attempts) result.message += ` 连接阶段已自动重试 ${attempts} 次。`;
    return { ...result, duration_ms: Math.max(0, Date.now() - start) };
  }
  private async runOnce(row: AccountRow, credentials: Credentials, hasSnapshot: boolean, signal: AbortSignal): Promise<RunResult> {
    let provider = Object.hasOwn(this.providers, row.provider) ? this.providers[row.provider] : undefined;
    if (!provider?.active) return { status: 'failed', message: '站点配置不存在或已移除，请检查站点管理。' };
    const method = row.login_via === 'github' || row.login_via === 'linuxdo' ? row.login_via : null;
    const upstream = provider.name === 'agentrouter' && row.auth_mode === 'session' && method ? scopedCookies(credentials.oauth_cookies, { method }) : [];
    let submitted = false, browser: BrowserSession | undefined, keepBrowser = false;
    const result: RunResult = { status: 'failed', message: '签到未完成。', reward: null };
    try {
      const proxy = resolveProxy(provider, credentials.proxy, this.config);
      let client: JobClient;
      if (provider.bypass_method || provider.waf_cookie_names.length) {
        const signature = this.signature(row, credentials, provider), cached = this.cache.get(row.id);
        this.cache.delete(row.id);
        if (cached && cached.signature === signature && cached.session.browser?.isConnected() && !cached.session.page?.isClosed()) {
          browser = cached.session;
        } else {
          if (cached) { await cached.session.close(); this.browsers.delete(cached.session); }
          browser = new BrowserSession(provider, this.config, proxy, signal); this.browsers.add(browser);
          await browser.start(row.auth_mode === 'password' ? { ...credentials, session: undefined } : credentials, upstream);
        }
        client = browser;
      } else client = new HttpJobClient(provider, row.auth_mode === 'password' ? { ...credentials, session: undefined } : credentials, proxy, this.config, signal);
      if (provider.custom && !isSub2API(provider) && this.store) {
        const publicReply = await client.request('/api/v1/settings/public', null, 'GET', undefined, false);
        const data = isRecord(publicReply.body) && publicReply.body.code === 0 && isRecord(publicReply.body.data) ? publicReply.body.data : null;
        if (publicReply.status === 200 && data && typeof data.site_name === 'string' && ['linuxdo_oauth_enabled', 'registration_enabled', 'check_in_enabled'].some(key => Object.hasOwn(data, key))) {
          provider = resolveCustomProtocol(provider, { protocol: 'sub2api' }, this.store, this.providers, hasSnapshot); client.provider = provider;
        }
      }
      let id = profileId(credentials.api_user), loginChecked: boolean | undefined, pendingUpdate: Partial<Credentials> | undefined;
      if (row.auth_mode === 'password') {
        if (typeof credentials.email !== 'string' || !credentials.email || typeof credentials.password !== 'string' || !credentials.password) return { ...result, status: 'manual_required', message: '账号密码信息不完整，请编辑账号或使用自己的浏览器重新授权。' };
        submitted = true;
        const login = await client.request(provider.login_api_path, null, 'POST', { [isSub2API(provider) ? 'email' : 'username']: credentials.email, password: credentials.password }, false);
        const data = login.status === 200 && !guardedResponse(login) ? responseData(login.body, provider) : null;
        const profile = isSub2API(provider) && data && isRecord(data.user) ? data.user : data;
        const found = profile ? profileId(profile.id) : null;
        if (!found || id !== null && found !== id) return { ...result, status: 'manual_required', message: '账号密码登录未通过或身份不一致；请核对账号信息，遇验证码或二次验证时使用自己的浏览器登录。' };
        id = found;
        if (isSub2API(provider)) {
          if (!secret(data?.access_token) || data?.refresh_token !== undefined && !secret(data.refresh_token)) return { ...result, status: 'manual_required', message: '站点尚未签发有效登录 Token，请使用自己的浏览器登录完成验证。' };
          client.token = data.access_token;
          pendingUpdate = { session: data.access_token, api_user: id, ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}) };
        } else {
          const session = await client.session();
          if (!session || !issuedSession(login.headers['set-cookie']?.split('\n') ?? [], session)) return { ...result, status: 'manual_required', message: '登录响应未签发有效站点 Session，请使用自己的浏览器登录完成验证。' };
          pendingUpdate = { session, api_user: id };
          if (typeof profile?.checked_in === 'boolean') loginChecked = profile.checked_in;
        }
      }
      if (!id || row.auth_mode === 'session' && !secret(credentials.session)) return { ...result, status: 'manual_required', message: '登录凭据或用户 ID 无效，请重新授权账号。' };
      let before = await readProfile(client, provider, id);
      if (isSub2API(provider) && before.response?.status === 401 && row.auth_mode === 'session' && secret(credentials.refresh_token)) {
        submitted = true;
        const refresh = await client.request('/api/v1/auth/refresh', null, 'POST', { refresh_token: credentials.refresh_token }, false);
        const data = refresh.status === 200 && !guardedResponse(refresh) ? responseData(refresh.body, provider) : null;
        if (!secret(data?.access_token) || data?.refresh_token !== undefined && !secret(data.refresh_token)) return { ...result, status: 'manual_required', message: '站点刷新登录态未通过，请重新授权。' };
        client.token = data.access_token;
        before = await readProfile(client, provider, id);
        if (!before.kind) pendingUpdate = { session: data.access_token, api_user: id, refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : credentials.refresh_token };
      }
      if (before.kind) {
        if (provider.name === 'agentrouter' && row.auth_mode === 'session' && before.response?.status === 401 && upstream.length && method && browser) {
          const fresh = await this.agentLogin(browser, method, id, credentials, undefined); submitted ||= browser.oauth?.submitted ?? false;
          keepBrowser = Boolean(fresh._session_update); Object.assign(result, fresh); return result;
        }
        if (before.kind === 'waf') return { ...result, status: 'manual_required', message: '站点对本次后台请求要求人工验证，未取得账号数据；请稍后重试或在自己的浏览器完成验证。' };
        if (before.kind === 'identity') return { ...result, message: '站点返回身份与保存账号不一致，未更新余额或凭据。' };
        if (before.kind === 'money') return { ...result, message: '账号余额字段缺失或格式异常，保留上次余额。' };
        const status = before.response?.status ?? 0;
        return { ...result, status: [401, 403, 429].includes(status) ? 'manual_required' : 'failed',
          message: [401, 403, 429].includes(status) ? '登录状态失效或访问被拒绝，请检查网络或使用自己的浏览器重新授权。' : '未能读取有效账号信息，保留上次余额。',
          _retryable: !submitted && transientStatus(status) };
      }
      const snapshot = before.snapshot!;
      if (row.auth_mode === 'session' || pendingUpdate) result._session_update = { ...pendingUpdate, site_cookies: await client.siteCookies() };
      if (!provider.sign_in_path) {
        Object.assign(result, { status: 'synced', before_balance: snapshot.balance, after_balance: snapshot.balance,
          used_quota: snapshot.used_quota, total_quota: snapshot.total,
          message: provider.name === 'agentrouter' ? '余额已同步，尚无本次签到凭据。AgentRouter 通过登录领取奖励。' : '余额已同步；此站点配置为仅同步余额。' });
        if (provider.name === 'agentrouter' && row.auth_mode === 'password') {
          result.status = loginChecked === true ? 'success' : 'synced';
          result.message = loginChecked === true ? 'AgentRouter 本次登录确认签到成功。' : loginChecked === false ? 'AgentRouter 本次登录未发放签到奖励。' : 'AgentRouter 登录完成，未返回签到确认标记。';
          delete result.before_balance;
          if (loginChecked === false) result.reward = 0;
          else if (loginChecked === true) result.message += ' 缺少登录前实时余额，奖励金额暂未确认。';
        } else if (provider.name === 'agentrouter' && row.auth_mode === 'session') {
          if (upstream.length && method && browser) {
            const fresh = await this.agentLogin(browser, method, id, credentials, snapshot); submitted ||= browser.oauth?.submitted ?? false;
            keepBrowser = Boolean(fresh._session_update);
            // Post-login money must come from its own matching self response.
            for (const key of ['after_balance', 'used_quota', 'total_quota'] as const) delete result[key];
            delete result._session_update; Object.assign(result, fresh);
          } else result.message += ' 当前没有对应的有效上游登录缓存，仅同步余额；本站 Session 不会触发自动登录。';
        }
        return result;
      }
      submitted = true;
      const checkin = await client.request(provider.sign_in_path, id, 'POST', {});
      Object.assign(result, classifyCheckinResponse(provider, checkin), { before_balance: snapshot.balance });
      try {
        const after = await readProfile(client, provider, id);
        if (after.kind || !after.snapshot) { result.message += ' 签到后余额未能读取，金额暂未确认；保留上次余额。'; return result; }
        result.after_balance = after.snapshot.balance; result.used_quota = after.snapshot.used_quota; result.total_quota = after.snapshot.total;
        if (result.status === 'success' && snapshot.total !== null && after.snapshot.total !== null) result.reward = Math.max(0, roundAmount(after.snapshot.total - snapshot.total));
        if (result.reward !== null && result.reward !== undefined && result.reward > 0) result.message += ` 本次额度增加 ${{ USD: '$', CNY: '¥', credits: '积分 ' }[provider.currency]}${result.reward.toFixed(2)}。`;
      } catch { result.message += ' 签到后余额未能读取，金额暂未确认；保留上次余额。'; }
      return result;
    } catch (error) {
      submitted ||= browser?.oauth?.submitted ?? false;
      if (signal.aborted || browser?.signal.aborted || this.stopping) return { status: 'interrupted', message: '服务停止，任务未完成。' };
      if (error instanceof ProtocolMismatch) return { ...result, status: 'manual_required', message: error.message };
      if (error instanceof PreflightError) return { ...result, status: error.manual ? 'manual_required' : 'failed', _retryable: !submitted && error.retryable,
        message: error.status ? `站点准备阶段返回 HTTP ${error.status}，尚未发送签到请求。请检查网络或网站验证。` : '后台浏览器或站点登录配置不可用，请检查部署设置或使用自己的浏览器重新授权。' };
      return { status: 'failed', reward: null, ...(result.before_balance !== undefined ? { before_balance: result.before_balance } : {}),
        _retryable: !submitted && transientError(error), message: proxyFailureMessage(error)
        ?? (submitted ? '请求可能已发送，尚未确认签到结果；已停止自动重试，请稍后查询余额或到官网确认。' : '后台连接失败或页面加载超时，请检查网络或账号代理后重试。') };
    } finally {
      if (browser) {
        if (keepBrowser && !this.stopping && !signal.aborted && !browser.signal.aborted) {
          const merged = { ...credentials, ...result._session_update };
          this.cache.set(row.id, { session: browser, signature: this.signature(row, merged, provider!), updated: Date.now() });
          while (this.cache.size > Math.max(1, this.config.maxConcurrentRuns)) {
            const oldest = [...this.cache.entries()].sort((left, right) => left[1].updated - right[1].updated)[0];
            this.cache.delete(oldest[0]); await oldest[1].session.close(); this.browsers.delete(oldest[1].session);
          }
        } else { await browser.close(); this.browsers.delete(browser); }
      }
    }
  }
  private async agentLogin(client: BrowserSession, method: OAuthMethod, id: string, credentials: Credentials, before?: Snapshot): Promise<RunResult> {
    const base: RunResult = { status: 'manual_required', message: '后台授权未完成，已保留登录缓存，请在自己的浏览器处理登录或验证。', reward: null,
      ...(before ? { before_balance: before.balance } : {}) };
    const oauth = await client.prepareOAuth(method), evidence = new LoginEvidence(client, oauth);
    const blocked = new Map<string, number>();
    const observeDocument = (response: Response) => {
      try {
        const url = new URL(response.url()), request = response.request();
        if (request.resourceType() !== 'document' || !['github.com', 'linux.do', 'connect.linux.do'].includes(url.hostname)) return;
        if (response.status() === 403 || response.status() === 429 || transientStatus(response.status())) blocked.set(url.hostname, response.status());
        else if (response.status() === 200) blocked.delete(url.hostname);
      } catch {}
    };
    client.context!.on('response', observeDocument);
    try {
      if (!await client.openOAuth(oauth)) return { ...base, message: '目标站点没有可验证的对应授权入口，请稍后重试或使用自己的浏览器重新授权。' };
      const deadline = Date.now() + (this.config.testMode ? 2000 : 30000);
      while (Date.now() < deadline) {
        aborted(client.signal);
        const login = await evidence.get();
        if (login) {
          if (profileId(login.profile.id) !== id) return { ...base, message: '重新登录身份与原账号不同，未更新余额或凭据。' };
          client.page = login.page;
          await client.settle();
          let money: ProfileRead | undefined;
          try { money = await readProfile(client, client.provider, id); }
          catch { /* A matching login can succeed even when a later balance read is unavailable. */ }
          if (money?.kind === 'identity' || login.session !== await client.session()) return { ...base, message: '登录后的身份或 Session 发生变化，未更新余额或凭据。' };
          const checked = login.profile.checked_in;
          const result: RunResult = { ...base, status: checked === true ? 'success' : 'synced',
            message: checked === true ? 'AgentRouter 确认本次登录签到成功。' : checked === false ? 'AgentRouter 本次登录未发放签到奖励。' : 'AgentRouter 登录完成，未返回签到确认标记。',
            _session_update: { session: login.session, api_user: id, site_cookies: await client.siteCookies(),
              oauth_cookies: scopedCookies(await client.context!.cookies(), { method }),
              ...(credentials.oauth_user_agent ? { oauth_user_agent: credentials.oauth_user_agent } : {}) } };
          if (!money?.snapshot) { result.message += ' 签到后余额未能读取，金额暂未确认；保留上次余额。'; return result; }
          Object.assign(result, { after_balance: money.snapshot.balance, used_quota: money.snapshot.used_quota, total_quota: money.snapshot.total });
          if (checked === false) result.reward = 0;
          else if (checked === true) {
            if (!before || before.total === null || money.snapshot.total === null) result.message += ' 缺少签到前实时余额，奖励金额暂未确认。';
            else {
              const gain = roundAmount(money.snapshot.total - before.total);
              result.reward = gain >= 0 ? gain : null;
              result.message += gain > 0 ? ` 本次总额度增加 $${gain.toFixed(2)}。` : gain === 0 ? ' 两次实时查询的总额度未增加，本次新增 $0.00。' : ' 总额度减少，本次奖励金额暂未确认。';
            }
          }
          return result;
        }
        const denial = [...blocked.values()][0];
        if (denial) return { ...base, status: transientStatus(denial) ? 'failed' : 'manual_required', _retryable: !oauth.submitted && transientStatus(denial),
          message: `上游授权页面返回 HTTP ${denial}，已保留登录缓存，请检查网络或在自己的浏览器完成验证。` };
        if (await client.upstreamBlocked(method)) return base;
        await client.approveOAuth(oauth);
        await delay(this.config.testMode ? 0 : 500, client.signal);
      }
      return { ...base, status: 'failed', _retryable: !oauth.submitted,
        message: oauth.submitted ? '登录请求已发送，但签到结果尚未确认；已停止自动重试，请稍后查询余额或到官网确认。' : '后台授权页面加载超时，已保留登录缓存，请稍后重试。' };
    } finally { client.context!.off('response', observeDocument); await evidence.close(); }
  }
  async discardBrowserSessions(id?: number): Promise<void> {
    const entries = [...this.cache.entries()].filter(([account]) => id === undefined || account === id);
    for (const [account, cached] of entries) {
      this.cache.delete(account); await cached.session.close(); this.browsers.delete(cached.session);
    }
  }
  async close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopping = true;
    for (const controller of this.controllers) controller.abort();
    this.cache.clear();
    this.closeTask = (async () => {
      await Promise.allSettled([...this.browsers].map(browser => browser.close()));
      await Promise.allSettled([...this.jobs]); this.browsers.clear();
    })();
    return this.closeTask;
  }
}
