import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import { detectBrowser, loadConfig } from '../server/config.js';
import { BrowserResources } from '../server/browser-resources.js';
import { BrowserSession, CheckinEngine, scopedCookies } from '../server/engine.js';
import { PROVIDERS, providerFromConfig } from '../server/providers.js';
import type { AccountRow, CookieData, Credentials, Provider, Template } from '../server/types.js';

const SESSION = 'fixture-site-session';
const NEW_SESSION = 'fixture-new-session';
const UPSTREAM = 'fixture-upstream-cache';
const chromePath = detectBrowser();
const realLaunch = chromium.launch.bind(chromium);
const config = () => loadConfig({}, { testMode: true, browserPath: chromePath, defaultProxyUrl: undefined });
function row(provider = 'fixture', overrides: Partial<AccountRow> = {}): AccountRow {
  return { id: 1, name: '本地合成账号', provider, auth_mode: 'session', encrypted: 'synthetic', enabled: 1, status: 'idle',
    last_run: null, next_run: null, last_message: '', balance: 50, used_quota: 10, total_quota: 60, has_snapshot: 1,
    interval_hours: 6, created_at: '2026-01-01T00:00:00Z', login_via: 'manual', ...overrides };
}
const credentials = (extra: Partial<Credentials> = {}): Credentials => ({ session: SESSION, api_user: '7', proxy: { mode: 'direct' }, ...extra });
function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body));
}
async function localSite(t: test.TestContext, template: Template, handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void | Promise<void>, overrides = {}) {
  const calls: { path: string; method: string; cookie: string; bearer: string; user: string; body: unknown }[] = [];
  const provider = providerFromConfig('fixture', { name: '合成站点', domain: 'https://fixture.example', template, ...overrides });
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    let body: unknown; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    calls.push({ path: new URL(req.url!, 'http://localhost').pathname, method: req.method!, cookie: req.headers.cookie ?? '',
      bearer: req.headers.authorization ?? '', user: String(req.headers[provider.api_user_key] ?? ''), body });
    try { await handler(req, res, body); } catch { req.socket.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); provider.domain = `http://127.0.0.1:${address.port}`;
  const engine = new CheckinEngine({ providers: { fixture: provider }, config: config() });
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { engine, provider, calls };
}

for (const template of ['newapi', 'sub2api'] as const) test(`${template} password login confirms fresh identity and money before one check-in POST`, async t => {
  let checked = false;
  const f = await localSite(t, template, (req, res, body) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === f.provider.login_api_path) {
      assert.deepEqual(body, { [template === 'sub2api' ? 'email' : 'username']: 'fixture-user', password: 'fixture-password' });
      json(res, 200, template === 'sub2api' ? { code: 0, data: { access_token: NEW_SESSION, refresh_token: 'fixture-refresh', user: { id: 7 } } }
        : { success: true, data: { id: 7, quota: 0, used_quota: 0 } }, { 'Set-Cookie': `session=${NEW_SESSION}; Path=/; HttpOnly; SameSite=Lax` });
    } else if (path === f.provider.sign_in_path) {
      checked = true; json(res, 200, template === 'sub2api' ? { code: 0, data: { reward: 2.5 } } : { success: true });
    } else json(res, 200, template === 'sub2api' ? { code: 0, data: { id: 7, balance: checked ? 12.5 : 10 } }
      : { success: true, data: { id: 7, quota: checked ? 6_250_000 : 5_000_000, used_quota: 1_250_000 } });
  });
  const result = await f.engine.run(row('fixture', { auth_mode: 'password', has_snapshot: 0 }), { email: 'fixture-user', password: 'fixture-password', proxy: { mode: 'direct' } });
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 12.5); assert.equal(result.reward, 2.5);
  assert.equal(result._session_update!.session, NEW_SESSION); assert.equal(result._session_update!.api_user, '7');
  assert.deepEqual(f.calls.map(call => [call.path, call.method]), [[f.provider.login_api_path, 'POST'], [f.provider.user_info_path, 'GET'], [f.provider.sign_in_path, 'POST'], [f.provider.user_info_path, 'GET']]);
  assert.equal(result.message.includes('fixture-password'), false); assert.equal(result.message.includes(NEW_SESSION), false);
  if (template === 'sub2api') { assert.equal(result.used_quota, null); assert.equal(result.total_quota, null); assert.equal(f.calls[1].bearer, 'Bearer ' + NEW_SESSION); }
  else { assert.equal(f.calls[1].cookie, 'session=' + NEW_SESSION); assert.equal(f.calls[1].user, '7'); }
});

test('custom paths, user header and currency conversion are used by check-in and fresh balance reads', async t => {
  let checked = false;
  const f = await localSite(t, 'sign_in', (req, res) => {
    if (req.method === 'POST') { checked = true; json(res, 200, { ret: 1 }); }
    else { assert.equal(req.headers['x-fixture-user'], '7'); json(res, 200, { success: true, data: { id: 7, quota: checked ? 12000 : 10000, used_quota: 2000 } }); }
  }, { user_info_path: '/account/profile', sign_in_path: '/account/claim', api_user_key: 'x-fixture-user', quota_per_unit: 1000, currency: 'CNY' });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 12); assert.equal(result.reward, 2);
  assert.match(result.message, /¥2\.00/); assert.equal(f.calls[1].path, '/account/claim');
});

for (const identity of [7, 8, null, true, 0]) test(`Sub2API refresh is a single submission and only persists a verified matching identity (${identity})`, async t => {
  const f = await localSite(t, 'sub2api', (req, res, body) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path.endsWith('/auth/refresh')) {
      assert.deepEqual(body, { refresh_token: 'fixture-old-refresh' }); assert.equal(req.headers.authorization, undefined);
      json(res, 200, { code: 0, data: { access_token: NEW_SESSION, refresh_token: 'fixture-new-refresh' } });
    } else if (path === f.provider.sign_in_path) json(res, 200, { code: 0, data: { reward: 0 } });
    else if (req.headers.authorization === 'Bearer ' + SESSION) json(res, 401, { code: 401 });
    else json(res, 200, { code: 0, data: { id: identity, balance: 8 } });
  });
  const result = await f.engine.run(row(), credentials({ refresh_token: 'fixture-old-refresh' }));
  assert.equal(f.calls.filter(call => call.path.endsWith('/auth/refresh')).length, 1);
  if (identity === 7) { assert.equal(result.status, 'success'); assert.equal(result._session_update!.session, NEW_SESSION); assert.equal(result._session_update!.refresh_token, 'fixture-new-refresh'); }
  else { assert.equal(result.status, 'failed'); assert.equal(result._session_update, undefined); assert.equal(f.calls.some(call => call.path === f.provider.sign_in_path), false); }
});

test('uncertain check-in submission stops automatic retries and never sends a second POST', async t => {
  const f = await localSite(t, 'newapi', (req, res) => {
    if (req.method === 'POST') req.socket.destroy();
    else json(res, 200, { success: true, data: { id: 7, quota: 25_000_000, used_quota: 5_000_000 } });
  });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'failed'); assert.match(result.message, /停止自动重试/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(f.calls.length, 2);
});

test('only temporary read-only preparation is retried twice before a single check-in submission', async t => {
  let reads = 0;
  const f = await localSite(t, 'newapi', (req, res) => {
    if (req.method === 'POST') json(res, 200, { success: true });
    else if (++reads <= 2) json(res, reads === 1 ? 503 : 408, { success: false });
    else json(res, 200, { success: true, data: { id: 7, quota: 25_000_000, used_quota: 5_000_000 } });
  });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'success'); assert.match(result.message, /自动重试 2 次/);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1); assert.equal(reads, 4);
});

test('explicit success is retained after a failed money read without fabricated after-balance', async t => {
  let checked = false;
  const f = await localSite(t, 'newapi', (req, res) => {
    if (req.method === 'POST') { checked = true; json(res, 200, { success: true }); }
    else if (checked) json(res, 503, { success: false, message: 'fixture-private-echo' });
    else json(res, 200, { success: true, data: { id: 7, quota: 25_000_000, used_quota: 5_000_000 } });
  });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, undefined); assert.equal(result.reward, null);
  assert.match(result.message, /保留上次余额/); assert.equal(result.message.includes('fixture-private-echo'), false);
  assert.equal(f.calls.length, 3);
});

test('missing or inconsistent self data blocks check-in and keeps saved amounts unchanged', async t => {
  const f = await localSite(t, 'newapi', (_req, res) => json(res, 200, { success: true, data: { id: 8, quota: 0, used_quota: 0 } }));
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'failed'); assert.equal(result.after_balance, undefined); assert.equal(result._session_update, undefined);
  assert.equal(f.calls.length, 1);
});

interface BrowserFixtureOptions {
  provider?: 'anyrouter' | 'agentrouter';
  checked?: boolean;
  loginId?: number;
  afterId?: number;
  missingMoney?: boolean;
  issueSession?: boolean;
  consent?: boolean;
  method?: 'github' | 'linuxdo';
  deniedUpstream?: number;
  missingWaf?: boolean;
  xhr?: boolean;
  omitRedirect?: boolean;
  lowMemory?: boolean;
  rawWaf?: boolean;
  rawFailure?: 'unauthorized' | 'identity' | 'money';
}
async function browserFixture(t: test.TestContext, options: BrowserFixtureOptions = {}) {
  const provider = structuredClone(PROVIDERS[options.provider ?? 'agentrouter']);
  const method = options.method ?? 'linuxdo';
  const paths: { origin: string; path: string; method: string; cookie: string }[] = [], added: CookieData[][] = [], contexts: BrowserContext[] = [];
  let launches = 0, fresh = false;
  const server = createServer((req, res) => {
    const target = provider.domain, url = new URL(req.url!, target);
    paths.push({ origin: target, path: url.pathname, method: req.method!, cookie: req.headers.cookie ?? '' });
    const html = (body: string, cookies?: string[]) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(cookies?.length ? { 'Set-Cookie': cookies } : {}) }); res.end(body);
    };
    if (['/', '/login'].includes(url.pathname)) {
      const waf = (options.missingWaf ? [] : provider.waf_cookie_names).map(name => `${name}=fixture-waf; Path=/; SameSite=Lax`);
      const extras = `<script>fetch('/api/user/self').catch(()=>{});fetch('/api/user/sign_in',{method:'POST'}).catch(()=>{});fetch('/api/user/logout').catch(()=>{});fetch('/api/user/login',{method:'POST',body:'{}'}).catch(()=>{});fetch('/api/user/register',{method:'POST',body:'{}'}).catch(()=>{})</script>`;
      const authorize = method === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://connect.linux.do/oauth2/authorize';
      const link = authorize + '?client_id=fixture-client&state=fixture-state' + (options.omitRedirect ? '' : '&redirect_uri=' + encodeURIComponent(target + '/oauth/' + method));
      return html(`<meta charset='utf-8'>${extras}<button type='button' onclick="fetch('/api/oauth/state').then(response=>response.json()).then(()=>{location.href='${link}'})">使用 ${method === 'github' ? 'GitHub' : 'LinuxDO'} 登录</button>`, waf);
    }
    if (url.pathname === '/api/status') return json(res, 200, { success: true, data: { system_name: 'Fixture', linuxdo_client_id: 'fixture-client', github_client_id: 'fixture-client' } });
    if (url.pathname === '/api/oauth/state') return json(res, 200, { success: true, data: 'fixture-state' });
    if (url.pathname === '/oauth/' + method) return html(options.xhr
      ? `<script>const xhr=new XMLHttpRequest();xhr.open('GET','/api/oauth/${method}?code=fixture-code&state=fixture-state');xhr.onload=()=>{JSON.parse(xhr.responseText);location.replace('/console')};xhr.send()</script>`
      : `<script>fetch('/api/oauth/${method}?code=fixture-code&state=fixture-state').then(response=>response.json()).then(()=>{location.replace('/console')})</script>`);
    if (url.pathname === '/api/oauth/' + method) {
      fresh = true;
      return json(res, 200, { success: true, data: { id: options.loginId ?? 7, ...(options.checked === undefined ? {} : { checked_in: options.checked }), quota: 0, used_quota: 0 } },
        options.issueSession === false ? {} : { 'Set-Cookie': `session=${NEW_SESSION}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (url.pathname === provider.user_info_path) {
      if (options.rawWaf && !String(req.headers.cookie).includes('acw_tc=fixture-waf')) return html('aliyun_waf: local verification required');
      if (options.rawFailure === 'unauthorized') return json(res, 401, { success: false });
      if (options.rawFailure === 'identity') return json(res, 200, { success: true, data: { id: 8, quota: 25_000_000, used_quota: 5_000_000 } });
      if (options.rawFailure === 'money') return json(res, 200, { success: true, data: { id: 7 } });
      if (fresh && options.missingMoney) return json(res, 200, { success: true, data: { id: options.afterId ?? 7 } });
      return json(res, 200, { success: true, data: { id: fresh ? options.afterId ?? 7 : 7, quota: fresh ? 26_000_000 : 25_000_000, used_quota: 5_000_000, checked_in: true } });
    }
    if (url.pathname === provider.sign_in_path) { fresh = true; return json(res, 200, { success: true }); }
    if (url.pathname === '/console') return html('<h1>Fixture dashboard</h1>');
    res.writeHead(404); res.end('Local fixture only');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  provider.domain = `http://127.0.0.1:${address.port}`;
  const target = provider.domain;
  t.mock.method(chromium, 'launch', async (launchOptions: LaunchOptions) => {
    launches++; assert.equal(launchOptions.headless, true); assert.ok(launchOptions.args?.includes('--no-proxy-server'));
    const browser = await realLaunch(launchOptions), createContext = browser.newContext.bind(browser);
    t.mock.method(browser, 'newContext', async (contextOptions: BrowserContextOptions) => {
      assert.equal(contextOptions.serviceWorkers, 'block');
      const context = await createContext(contextOptions); contexts.push(context);
      const addCookies = context.addCookies.bind(context);
      t.mock.method(context, 'addCookies', async (cookies: CookieData[]) => { added.push(structuredClone(cookies)); await addCookies(cookies); });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === target) return route.continue();
        paths.push({ origin: url.origin, path: url.pathname, method: req.method(), cookie: req.headers().cookie ?? '' });
        const html = (body: string, headers: Record<string, string> = {}) => route.fulfill({ status: 200, contentType: 'text/html', headers, body });
        const upstream = method === 'github' ? 'https://github.com' : 'https://connect.linux.do';
        if (url.origin === upstream) {
          if (options.deniedUpstream) return route.fulfill({ status: options.deniedUpstream, contentType: 'text/html', body: 'Synthetic denial' });
          const returnUrl = target + '/oauth/' + method + '?code=fixture-code&state=fixture-state';
          if (options.consent && req.method() === 'GET' && (url.pathname === '/login/oauth/authorize' || url.pathname === '/oauth2/authorize')) {
            const action = method === 'github' ? '/login/oauth/authorize' : '/oauth2/approve';
            return html(`<meta charset='utf-8'><a href='${target}'>Fixture application</a><form action='${action}' method='post'><input type='hidden' name='client_id' value='fixture-client'><input type='hidden' name='state' value='fixture-state'><button type='submit'>${method === 'github' ? 'Authorize Fixture' : '允许'}</button></form>`);
          }
          return html(`<script>location.replace(${JSON.stringify(returnUrl)})</script>`);
        }
        // Every URL is handled locally; fixtures never access a real target or upstream site.
        return route.abort();
      });
      return context;
    });
    return browser;
  });
  const resources = new BrowserResources();
  const engine = new CheckinEngine({ providers: { [provider.name]: provider }, config: { ...config(), lowMemory: options.lowMemory ?? false }, browserResources: resources });
  t.after(async () => { await engine.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const upstream: CookieData = { name: 'user_session', value: UPSTREAM, domain: method === 'github' ? '.github.com' : '.linux.do', path: '/', secure: true, sameSite: 'Lax', expires: -1 };
  return { engine, provider, paths, added, contexts, upstream, resources, get launches() { return launches; } };
}

test('Agent Session-only self response with checked_in=true remains a sync with no login or logout', { skip: !chromePath }, async t => {
  const f = await browserFixture(t);
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials());
  assert.equal(result.status, 'synced'); assert.equal(result.after_balance, 50); assert.equal(result.reward, null);
  assert.match(result.message, /没有对应的有效上游登录缓存/);
  assert.deepEqual(f.paths.filter(call => call.path.startsWith('/api/user')).map(call => call.path), ['/api/user/self']);
  assert.equal(f.paths.some(call => call.origin.includes('linux.do')), false);
  assert.equal(f.added.filter(batch => batch.some(cookie => cookie.name === 'session')).length, 1);
});

test('Any WAF bootstrap precedes Session installation, then identity/check-in/fresh balance are explicit', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { provider: 'anyrouter' });
  const result = await f.engine.run(row('anyrouter'), credentials());
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 52); assert.equal(result.reward, 2);
  assert.deepEqual(f.paths.filter(call => call.path.startsWith('/api/user')).map(call => [call.path, call.method]),
    [['/api/user/self', 'GET'], ['/api/user/sign_in', 'POST'], ['/api/user/self', 'GET']]);
  assert.equal(f.paths[0].cookie.includes(SESSION), false);
  for (const call of f.paths.filter(call => call.path.startsWith('/api/user'))) {
    assert.match(call.cookie, /acw_tc=fixture-waf/); assert.match(call.cookie, /cdn_sec_tc=fixture-waf/); assert.match(call.cookie, /acw_sc__v2=fixture-waf/);
  }
});

test('missing required WAF cookie blocks account Session and business requests', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { missingWaf: true });
  const result = await f.engine.run(row('agentrouter'), credentials());
  assert.equal(result.status, 'manual_required'); assert.equal(f.added.some(batch => batch.some(cookie => cookie.name === 'session')), false);
  assert.equal(f.paths.some(call => call.path.startsWith('/api/user')), false);
});

for (const method of ['linuxdo', 'github'] as const) test(`Agent ${method} uses only one matching official authorization and fresh matching money`, { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, consent: true, method });
  const creds = credentials({ oauth_cookies: [f.upstream], oauth_user_agent: 'FixtureBrowser/1.0' });
  const result = await f.engine.run(row('agentrouter', { login_via: method }), creds);
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 52); assert.equal(result.total_quota, 62); assert.equal(result.reward, 2);
  assert.equal(result._session_update!.session, NEW_SESSION); assert.equal(result._session_update!.api_user, '7');
  assert.equal(result._session_update!.oauth_cookies!.some(cookie => cookie.value === UPSTREAM), true);
  assert.equal(f.paths.filter(call => call.path === '/api/oauth/' + method).length, 1);
  assert.equal(f.paths.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.paths.some(call => call.path === '/api/user/logout' || call.path === '/api/user/login'), false);
  assert.equal(f.paths.filter(call => call.path === '/api/user/self').length, 2);
  assert.equal(f.paths.filter(call => call.origin === f.provider.domain).some(call => call.cookie.includes(UPSTREAM)), false);
});

for (const checked of [false, undefined]) test(`Agent fresh login without a true check-in flag remains synced (${checked})`, { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked });
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'synced', JSON.stringify({ message: result.message, duration_ms: result.duration_ms,
    paths: f.paths.map(({ origin, path, method }) => ({ origin, path, method })) }));
  assert.equal(result.after_balance, 52); assert.equal(result.reward, checked === false ? 0 : null);
});

test('Agent confirmed login without post-login money saves new session and keeps old database amounts', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, missingMoney: true });
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, undefined); assert.equal(result.used_quota, undefined); assert.equal(result.total_quota, undefined);
  assert.equal(result.reward, null); assert.equal(result._session_update!.session, NEW_SESSION); assert.match(result.message, /保留上次余额/);
});

for (const mismatch of ['login', 'self'] as const) test(`Agent rejects ${mismatch} identity mismatch without credential or money updates`, { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, ...(mismatch === 'login' ? { loginId: 8 } : { afterId: 8 }) });
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'manual_required'); assert.equal(result.after_balance, undefined); assert.equal(result._session_update, undefined);
  assert.equal(f.paths.filter(call => call.path === '/api/oauth/linuxdo').length, 1);
});

test('Agent ignores login evidence without the newly issued matching Session and never replays callback', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, issueSession: false });
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'failed'); assert.equal(result._session_update, undefined); assert.equal(result.after_balance, undefined);
  assert.match(result.message, /停止自动重试/); assert.equal(f.paths.filter(call => call.path === '/api/oauth/linuxdo').length, 1); assert.equal(f.launches, 1);
});

test('Agent reuses its own successful headless context and discards it on reauthorization', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true });
  const account = row('agentrouter', { login_via: 'linuxdo' }), creds = credentials({ oauth_cookies: [f.upstream] });
  const first = await f.engine.run(account, creds), second = await f.engine.run(account, { ...creds, ...first._session_update });
  assert.equal(first.status, 'success'); assert.equal(second.status, 'success'); assert.equal(f.launches, 1);
  await f.engine.discardBrowserSessions(account.id); assert.equal(f.contexts[0].pages().length, 0);
  const third = await f.engine.run(account, { ...creds, ...second._session_update }); assert.equal(third.status, 'success'); assert.equal(f.launches, 2);
});

test('low-memory Agent OAuth preserves verified login evidence while closing each successful browser', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, lowMemory: true });
  const account = row('agentrouter', { login_via: 'linuxdo' }), creds = credentials({ oauth_cookies: [f.upstream] });
  const first = await f.engine.run(account, creds);
  assert.equal(first.status, 'success'); assert.equal(first._session_update!.session, NEW_SESSION);
  assert.equal(first._session_update!.api_user, '7'); assert.equal(first.reward, 2);
  assert.equal(f.contexts[0].pages().length, 0); assert.equal(f.resources.activeCount, 0);
  const second = await f.engine.run(account, { ...creds, ...first._session_update });
  assert.equal(second.status, 'success'); assert.equal(second._session_update!.session, NEW_SESSION);
  assert.equal(f.launches, 2); assert.equal(f.contexts[1].pages().length, 0); assert.equal(f.resources.activeCount, 0);
  assert.equal(f.paths.filter(call => call.path === '/api/oauth/linuxdo').length, 2);
});

test('low-memory Agent Session balance uses one raw GET without starting Chromium', async t => {
  const f = await browserFixture(t, { lowMemory: true });
  const result = await f.engine.run(row('agentrouter'), credentials());
  assert.equal(result.status, 'synced'); assert.equal(result.after_balance, 50); assert.equal(result.reward, null);
  assert.equal(f.launches, 0); assert.equal(f.resources.activeCount, 0);
  assert.deepEqual(f.paths.map(call => [call.path, call.method]), [['/api/user/self', 'GET']]);
});

for (const rawFailure of ['unauthorized', 'identity', 'money'] as const) test(`low-memory Agent ${rawFailure} JSON keeps failure semantics without starting a login`, async t => {
  const f = await browserFixture(t, { lowMemory: true, rawFailure });
  const result = await f.engine.run(row('agentrouter'), credentials());
  assert.equal(result.status, rawFailure === 'unauthorized' ? 'manual_required' : 'failed');
  assert.equal(result.after_balance, undefined); assert.equal(result._session_update, undefined); assert.equal(result.reward, null);
  assert.equal(f.launches, 0); assert.equal(f.resources.activeCount, 0);
  assert.deepEqual(f.paths.map(call => [call.path, call.method]), [['/api/user/self', 'GET']]);
});

test('low-memory Agent balance falls back from raw WAF HTML to one temporary browser and read-only GET', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { lowMemory: true, rawWaf: true });
  const result = await f.engine.run(row('agentrouter'), credentials());
  assert.equal(result.status, 'synced'); assert.equal(result.after_balance, 50); assert.equal(result.reward, null);
  assert.equal(f.launches, 1); assert.equal(f.resources.activeCount, 0); assert.equal(f.contexts[0].pages().length, 0);
  assert.equal(f.paths[0].path, '/api/user/self');
  assert.equal(f.paths.filter(call => call.path === '/api/user/self').length, 2);
  assert.equal(f.paths.every(call => call.method === 'GET'), true);
  assert.equal(f.paths.some(call => call.path.includes('/oauth/') || call.path === '/api/user/logout' || call.path === '/api/user/login'), false);
});

test('low-memory Any retains WAF browser preparation and makes one check-in submission', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { provider: 'anyrouter', lowMemory: true });
  const result = await f.engine.run(row('anyrouter'), credentials());
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 52); assert.equal(result.reward, 2);
  assert.equal(f.launches, 1); assert.equal(f.resources.activeCount, 0); assert.equal(f.contexts[0].pages().length, 0);
  assert.equal(f.paths[0].path, '/'); assert.equal(f.paths[0].cookie.includes(SESSION), false);
  assert.deepEqual(f.paths.filter(call => call.path.startsWith('/api/user')).map(call => [call.path, call.method]),
    [['/api/user/self', 'GET'], ['/api/user/sign_in', 'POST'], ['/api/user/self', 'GET']]);
});

test('Agent Axios-style XHR callback retains original response evidence before immediate SPA navigation', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, xhr: true });
  const result = await f.engine.run(row('agentrouter', { login_via: 'linuxdo' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'success', JSON.stringify({ result, paths: f.paths })); assert.equal(result.after_balance, 52); assert.equal(result.reward, 2);
  assert.equal(result._session_update!.session, NEW_SESSION); assert.equal(f.paths.filter(call => call.path === '/api/oauth/linuxdo').length, 1);
});

test('Agent GitHub accepts registered default callback with no redirect_uri and still verifies fresh target Session/ID', { skip: !chromePath }, async t => {
  const f = await browserFixture(t, { checked: true, method: 'github', consent: true, omitRedirect: true });
  const result = await f.engine.run(row('agentrouter', { login_via: 'github' }), credentials({ oauth_cookies: [f.upstream] }));
  assert.equal(result.status, 'success'); assert.equal(result.after_balance, 52); assert.equal(result._session_update!.api_user, '7');
  assert.equal(f.paths.filter(call => call.path === '/api/oauth/github').length, 1);
});

test('OAuth cookie scope drops unrelated, target, expired, partitioned and incompatible cookies', () => {
  const cookie = { name: 'user_session', value: UPSTREAM, domain: '.linux.do', path: '/', secure: true, sameSite: 'Lax', expires: -1 };
  const items = [cookie, { ...cookie, domain: 'connect.linux.do' }, { ...cookie, domain: '.github.com' }, { ...cookie, domain: 'agentrouter.org' },
    { ...cookie, domain: 'evil-linux.do' }, { ...cookie, name: 'expired', expires: 1 }, { ...cookie, name: 'partitioned', partitionKey: {} },
    { ...cookie, name: 'insecure', sameSite: 'None', secure: false }, { ...cookie, name: 'bad', sameSite: 'unknown' }];
  assert.deepEqual(scopedCookies(items, { method: 'linuxdo' }).map(cookie => cookie.domain), ['.linux.do', 'connect.linux.do']);
  assert.deepEqual(scopedCookies(items, { method: 'github' }).map(cookie => cookie.domain), ['.github.com']);
  assert.deepEqual(scopedCookies(items, { method: 'manual' }), []);
});

test('shutdown during asynchronous browser launch closes late browser before any context setup or cache reuse', async t => {
  let release!: (browser: Browser) => void, launches = 0, contexts = 0, closes = 0;
  const lateBrowser = { newContext: async () => { contexts++; throw new Error('must not run'); }, close: async () => { closes++; }, isConnected: () => true } as unknown as Browser;
  t.mock.method(chromium, 'launch', () => { launches++; return new Promise<Browser>(resolve => { release = resolve; }); });
  const engine = new CheckinEngine({ providers: structuredClone(PROVIDERS), config: loadConfig({}, { testMode: true, browserPath: '/synthetic/chromium' }) });
  const run = engine.run(row('anyrouter'), credentials());
  while (!launches) await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1);
  const closing = engine.close();
  assert.equal((await engine.run(row('anyrouter', { id: 2 }), credentials())).status, 'interrupted');
  release(lateBrowser);
  await closing; assert.equal((await run).status, 'interrupted');
  assert.equal(closes, 1); assert.equal(contexts, 0); assert.equal(launches, 1);
  await engine.discardBrowserSessions(); assert.equal(closes, 1);
});

test('shutdown during newContext setup prevents routing, cookies or pages after async setup completes', async t => {
  let release!: (context: BrowserContext) => void, setup = 0, closes = 0;
  const context = { route: async () => { setup++; }, newPage: async () => { setup++; }, addCookies: async () => { setup++; } } as unknown as BrowserContext;
  const browser = { newContext: () => new Promise<BrowserContext>(resolve => { release = resolve; }), close: async () => { closes++; }, isConnected: () => true } as unknown as Browser;
  t.mock.method(chromium, 'launch', async () => browser);
  const engine = new CheckinEngine({ providers: structuredClone(PROVIDERS), config: loadConfig({}, { testMode: true, browserPath: '/synthetic/chromium' }) });
  const run = engine.run(row('anyrouter'), credentials());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const closing = engine.close(); release(context);
  await closing; assert.equal((await run).status, 'interrupted'); assert.equal(closes, 1); assert.equal(setup, 0);
});
