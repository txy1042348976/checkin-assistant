import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import { detectBrowser, loadConfig } from '../server/config.js';
import { BrowserSession } from '../server/engine.js';
import { HttpError } from '../server/errors.js';
import { UserBrowserImports } from '../server/imports.js';
import { PROVIDERS } from '../server/providers.js';
import { WebSecurity } from '../server/security.js';
import { Store } from '../server/store.js';

const SESSION = 'local-manual-waf-private-session';
const ROTATED_SESSION = 'local-manual-waf-rotated-session';
const ORIGINAL_SESSION = 'local-manual-waf-original-session';
const chromePath = detectBrowser({});
const realLaunch = chromium.launch.bind(chromium);
const payload = () => ({ session: SESSION, api_user: '7' });
const isStatus = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;
const profile = (id = 7) => ({ success: true, data: { id, username: 'local-fixture', quota: 25_000_000, used_quota: 5_000_000 } });

interface ObservedRequest {
  path: string;
  method: string;
  cookie: string;
  user: string;
  raw: boolean;
  fresh: boolean;
}

interface FixtureOptions {
  raw?: 'waf' | 'success' | 'unauthorized';
  missingWaf?: boolean;
  freshId?: number;
  holdFresh?: boolean;
  rotateSession?: 'login' | 'self';
  wafDisabled?: 'method' | 'names';
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}

function json(response: ServerResponse, status: number, body: unknown, cookies: string[] = []) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  response.end(JSON.stringify(body));
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-manual-waf-'));
  const provider = structuredClone(PROVIDERS.anyrouter);
  if (options.wafDisabled === 'method') provider.bypass_method = null;
  if (options.wafDisabled === 'names') provider.waf_cookie_names = [];
  const observed: ObservedRequest[] = [];
  const browserEvents: Record<string, unknown>[] = [];
  for (const phase of ['start', 'navigate', 'request', 'session'] as const) {
    const original = BrowserSession.prototype[phase];
    t.mock.method(BrowserSession.prototype, phase, async function(this: BrowserSession, ...args: unknown[]) {
      const started = Date.now();
      const pathname = ['navigate', 'request'].includes(phase) && typeof args[0] === 'string'
        ? new URL(args[0], provider.domain).pathname : undefined;
      browserEvents.push({ phase, path: pathname, event: 'started' });
      try {
        const result: unknown = await Reflect.apply(original, this, args);
        browserEvents.push({ phase, path: pathname, event: 'finished', duration_ms: Date.now() - started });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : '', name = error instanceof Error ? error.name : 'UnknownError';
        const diagnostic = { phase, path: pathname, event: 'failed', duration_ms: Date.now() - started,
          error_type: ['Error', 'TimeoutError', 'TransportError', 'HttpError', 'PreflightError', 'AssertionError',
            'TypeError', 'RangeError'].includes(name) ? name : 'UnknownError',
          navigation: /navigation|net::ERR_ABORTED|frame was detached/i.test(message),
          context_destroyed: /execution context was destroyed|cannot find context/i.test(message),
          closed: /target.*closed|page.*closed|browser.*closed/i.test(message),
          timeout: /timeout|timed out/i.test(message) };
        browserEvents.push(diagnostic); t.diagnostic(JSON.stringify(diagnostic));
        throw error;
      }
    });
  }
  const browsers: Browser[] = [];
  const contexts: BrowserContext[] = [];
  const added: Parameters<BrowserContext['addCookies']>[0][] = [];
  const closes = new Map<Browser, number>();
  const freshStarted = deferred(), disconnected = deferred();
  let freshResponses = 0;
  let imports: UserBrowserImports | undefined, store: Store | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, provider.domain);
    const raw = url.searchParams.has('_checkin_assistant_verify');
    const fresh = url.searchParams.has('_checkin_assistant_req');
    const cookie = request.headers.cookie || '';
    observed.push({ path: url.pathname, method: request.method!, cookie,
      user: String(request.headers[provider.api_user_key] || ''), raw, fresh });
    if (url.pathname === provider.user_info_path && raw) {
      if (options.raw === 'success') return json(response, 200, profile());
      if (options.raw === 'unauthorized') return json(response, 401, { success: false, message: 'Fixture Session invalid' });
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<h1>访问验证</h1><p>aliyun_waf fixture challenge</p>');
      return;
    }
    if (url.pathname === '/' || url.pathname === provider.login_path) {
      const cookies = (options.missingWaf ? [] : provider.waf_cookie_names)
        .map(name => `${name}=local-waf-${name}; Path=/; SameSite=Lax`);
      if (options.rotateSession === 'login' && url.pathname === provider.login_path) {
        cookies.push(`session=${ROTATED_SESSION}; Path=/; HttpOnly; SameSite=Lax`);
      }
      // These page scripts must never reach the server. Only the transport's
      // explicitly permitted identity GET may use the supplied account Session.
      const hostile = `<script>
        fetch('/api/user/self').catch(()=>{});
        fetch('/api/user/login',{method:'POST',body:'{}'}).catch(()=>{});
        fetch('/api/user/sign_in',{method:'POST'}).catch(()=>{});
        fetch('/api/user/logout').catch(()=>{});
        fetch('/api/oauth/state').catch(()=>{});
        fetch('/api/user/register',{method:'POST',body:'{}'}).catch(()=>{});
      </script>`;
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
      response.end('<!doctype html><meta charset="utf-8"><title>Local WAF fixture</title>' + hostile);
      return;
    }
    if (url.pathname === provider.user_info_path && fresh) {
      freshStarted.resolve();
      if (options.holdFresh) return;
      freshResponses++;
      if (!cookie.includes(`session=${SESSION}`) || !provider.waf_cookie_names.every(name => cookie.includes(`${name}=local-waf-${name}`))) {
        return json(response, 401, { success: false });
      }
      return json(response, 200, profile(options.freshId), options.rotateSession === 'self'
        ? [`session=${ROTATED_SESSION}; Path=/; HttpOnly; SameSite=Lax`] : []);
    }
    response.writeHead(404); response.end('Only local fixture routes are available');
  });
  t.after(async () => {
    await imports?.close();
    for (const browser of browsers) if (browser.isConnected()) await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  provider.domain = `http://127.0.0.1:${address.port}`;
  t.mock.method(chromium, 'launch', async (launchOptions: LaunchOptions) => {
    assert.equal(launchOptions.headless, true);
    assert.equal(launchOptions.executablePath, chromePath);
    assert.ok(launchOptions.args?.includes('--no-proxy-server'));
    const browser = await realLaunch(launchOptions);
    browsers.push(browser);
    browser.once('disconnected', disconnected.resolve);
    const close = browser.close.bind(browser);
    t.mock.method(browser, 'close', async () => { closes.set(browser, (closes.get(browser) || 0) + 1); await close(); });
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (contextOptions: BrowserContextOptions) => {
      assert.equal(contextOptions.serviceWorkers, 'block');
      assert.equal(contextOptions.storageState, undefined);
      const context = await newContext(contextOptions); contexts.push(context);
      const addCookies = context.addCookies.bind(context);
      t.mock.method(context, 'addCookies', async (cookies: Parameters<BrowserContext['addCookies']>[0]) => {
        added.push(structuredClone(cookies)); await addCookies(cookies);
      });
      // Installed before BrowserSession's route shield. Its permitted requests
      // fall through here; every nonfixture origin is aborted, never contacted.
      await context.route('**/*', route => new URL(route.request().url()).origin === provider.domain ? route.continue() : route.abort());
      return context;
    });
    return browser;
  });
  const providers = { anyrouter: provider };
  const config = loadConfig({}, { dataDir: directory, testMode: true, browserPath: chromePath,
    adminPassword: 'Fixture-Secure-2026!', defaultProxyUrl: undefined });
  store = new Store({ dataDir: directory, providers, timezone: config.timezone });
  const security = new WebSecurity(store, config, 'local-fixture-csrf'); await security.ready;
  imports = new UserBrowserImports(store, providers, security, config);
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '本地 WAF 手填账号', interval_hours: 6,
    origin: provider.domain, proxy: { mode: 'direct' as const } };
  return { provider, store, imports, input, observed, browsers, contexts, added, closes,
    diagnostics: () => ({ browser_events: browserEvents, browser_count: browsers.length, context_count: contexts.length,
      requests: observed.map(({ path, method, raw, fresh }) => ({ path, method, raw, fresh })) }),
    freshStarted: freshStarted.promise, disconnected: disconnected.promise, get freshResponses() { return freshResponses; } };
}

function assertReadOnly(f: Awaited<ReturnType<typeof fixture>>) {
  assert.ok(f.observed.every(request => request.method === 'GET'));
  assert.ok(f.observed.every(request => ['/', f.provider.login_path, '/favicon.ico', f.provider.user_info_path].includes(request.path)));
  assert.ok(f.observed.filter(request => request.path === f.provider.user_info_path).every(request => request.raw || request.fresh),
    'unsolicited page identity reads must be blocked');
  assert.equal(f.store.runs().length, 0, 'identity verification must never create a check-in run');
}

function assertClosed(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.browsers.length, 1);
  assert.equal(f.contexts.length, 1);
  assert.equal(f.browsers[0].isConnected(), false);
  assert.equal(f.browsers[0].contexts().length, 0);
  assert.equal(f.closes.get(f.browsers[0]), 1, 'temporary browser must be closed exactly once');
}

test('manual Any Session and ID survive a WAF HTML challenge using a temporary read-only browser', { skip: !chromePath }, async t => {
  const f = await fixture(t);
  const result = await f.imports.importManual(f.input, payload(), '1'.repeat(32)).catch(error => {
    t.diagnostic(JSON.stringify(f.diagnostics()));
    throw error;
  });
  assert.equal(result.status, 'success'); assert.equal(f.store.accounts().length, 1);
  const row = f.store.account(result.account_id!)!;
  assert.equal(row.balance, 50); assert.equal(row.used_quota, 10); assert.equal(row.total_quota, 60);
  const credentials = f.store.credentials(row);
  assert.equal(credentials.session, SESSION); assert.equal(credentials.api_user, '7');
  assert.deepEqual(credentials.site_cookies ?? [], [], 'temporary WAF cookies must not enter saved credentials');
  assert.deepEqual(credentials.oauth_cookies ?? [], []);
  assert.equal(JSON.stringify(f.store.dashboard()).includes(SESSION), false);
  const identity = f.observed.filter(request => request.path === f.provider.user_info_path);
  assert.equal(identity.length, 2);
  assert.equal(identity[0].raw, true); assert.equal(identity[0].cookie, `session=${SESSION}`); assert.equal(identity[0].user, '7');
  assert.equal(identity[1].fresh, true); assert.equal(identity[1].user, '7');
  for (const name of f.provider.waf_cookie_names) assert.ok(identity[1].cookie.includes(`${name}=local-waf-${name}`));
  assert.ok(identity[1].cookie.includes(`session=${SESSION}`));
  const bootstrap = f.observed.find(request => request.path === '/')!;
  assert.ok(bootstrap); assert.equal(bootstrap.cookie.includes('session='), false);
  assert.equal(f.added.length, 1); assert.equal(f.added[0].length, 1);
  assert.equal(f.added[0][0].name, 'session'); assert.equal(f.added[0][0].value, SESSION);
  assert.equal(f.observed.find(request => request.path === f.provider.login_path)!.cookie.includes(`session=${SESSION}`), true);
  assertReadOnly(f); assertClosed(f);
});

for (const raw of ['success', 'unauthorized'] as const) {
  test(`manual Any JSON ${raw === 'success' ? 'success' : '401'} stays on raw HTTP without launching Chrome`, async t => {
    const f = await fixture(t, { raw });
    const task = f.imports.importManual(f.input, payload(), '2'.repeat(32));
    if (raw === 'success') { assert.equal((await task).status, 'success'); assert.equal(f.store.accounts().length, 1); }
    else {
      await assert.rejects(task, isStatus(422));
      assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null);
      assert.equal(f.imports.view('2'.repeat(32))!.status, 'failed');
    }
    assert.equal(f.browsers.length, 0); assert.equal(f.observed.length, 1);
    assert.equal(f.observed[0].raw, true); assertReadOnly(f);
  });
}

for (const wafDisabled of ['method', 'names'] as const) {
  test(`manual HTML rejection launches no browser when the provider WAF ${wafDisabled === 'method' ? 'method' : 'cookie names'} is absent`, async t => {
    const f = await fixture(t, { wafDisabled });
    await assert.rejects(f.imports.importManual(f.input, payload(), '3'.repeat(32)), isStatus(422));
    assert.equal(f.browsers.length, 0); assert.equal(f.observed.length, 1);
    assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null); assertReadOnly(f);
  });
}

test('manual Any WAF fallback fails before Session installation when required cookies are missing', { skip: !chromePath }, async t => {
  const f = await fixture(t, { missingWaf: true });
  await assert.rejects(f.imports.importManual(f.input, payload(), '4'.repeat(32)), isStatus(422));
  assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null);
  assert.equal(f.added.length, 0);
  assert.equal(f.observed.some(request => request.fresh || request.path === f.provider.login_path), false);
  assert.equal(f.observed.find(request => request.path === '/')!.cookie.includes('session='), false);
  assertReadOnly(f); assertClosed(f);
});

test('manual WAF fresh identity mismatch preserves original account credentials and amounts', { skip: !chromePath }, async t => {
  const f = await fixture(t, { freshId: 8 });
  const id = f.store.addAccount({ name: 'original-local-account', provider: 'anyrouter', auth_mode: 'session', interval_hours: 12,
    enabled: false, session: ORIGINAL_SESSION, api_user: '7' });
  f.store.patch(id, { balance: 42, used_quota: 8, total_quota: 50, has_snapshot: 1 });
  await assert.rejects(f.imports.importManual({ ...f.input, account_id: id }, payload(), '5'.repeat(32)), isStatus(422));
  const row = f.store.account(id)!;
  assert.equal(f.store.accounts().length, 1); assert.equal(row.enabled, 0); assert.equal(row.name, 'original-local-account');
  assert.equal(row.balance, 42); assert.equal(row.used_quota, 8); assert.equal(row.total_quota, 50);
  assert.equal(f.store.credentials(row).session, ORIGINAL_SESSION);
  assert.equal(f.observed.filter(request => request.fresh).length, 1); assert.equal(f.imports.current(), null);
  assertReadOnly(f); assertClosed(f);
});

for (const rotateSession of ['login', 'self'] as const) {
  test(`manual WAF ${rotateSession === 'login' ? 'public login page' : 'fresh identity response'} Session rotation cannot save the old Session`, { skip: !chromePath }, async t => {
    const f = await fixture(t, { rotateSession });
    await assert.rejects(f.imports.importManual(f.input, payload(), '6'.repeat(32)), error => {
      assert.ok(error instanceof HttpError); assert.equal(error.status, 422); assert.match(error.message, /登录状态已变化/); return true;
    });
    assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null);
    assert.equal(f.observed.filter(request => request.fresh).length, rotateSession === 'login' ? 0 : 1);
    assertReadOnly(f); assertClosed(f);
  });
}

test('cancelling a held manual WAF identity GET immediately closes Chrome without awaiting its response', { skip: !chromePath, timeout: 15_000 }, async t => {
  const f = await fixture(t, { holdFresh: true });
  const requestId = '7'.repeat(32);
  const task = f.imports.importManual(f.input, payload(), requestId);
  const rejected = assert.rejects(task, isStatus(409));
  await within(f.freshStarted, 10_000, 'temporary browser did not begin its explicit identity request');
  assert.equal(f.imports.view(requestId)!.status, 'verifying');
  assert.equal(f.imports.cancel(requestId), true);
  await within(Promise.all([rejected, f.disconnected]), 2000, 'cancelled import left its temporary browser alive until the held fetch completed');
  assert.equal(f.freshResponses, 0, 'the fixture never releases the held identity response');
  assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.view(requestId)!.status, 'cancelled');
  assert.equal(f.imports.current(), null);
  assertReadOnly(f); assertClosed(f);
});
