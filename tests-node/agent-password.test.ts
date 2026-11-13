import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../server/config.js';
import { CheckinEngine } from '../server/engine.js';
import { PROVIDERS } from '../server/providers.js';
import type { AccountRow, Credentials } from '../server/types.js';

const SESSION = 'isolated-agent-password-new-session';
const OLD_SESSION = 'isolated-agent-password-old-session';
const PASSWORD = 'isolated-agent-site-password';

interface ObservedRequest {
  path: string;
  method: string;
  cookie: string;
  user: string;
  bearer: string;
  body: unknown;
}

function row(): AccountRow {
  return { id: 1, name: 'Agent 密码隔离账号', provider: 'agentrouter', auth_mode: 'password', encrypted: 'fixture',
    enabled: 1, status: 'idle', last_run: null, next_run: null, last_message: '', balance: 40,
    used_quota: 5, total_quota: 45, has_snapshot: 1, interval_hours: 6,
    created_at: '2026-01-01T00:00:00Z', login_via: 'password' };
}

function credentials(identity = 'agent-alias', extra: Partial<Credentials> = {}): Credentials {
  return { email: identity, password: PASSWORD, session: OLD_SESSION, proxy: { mode: 'direct' }, ...extra };
}

function json(response: ServerResponse, status: number, data: unknown, cookies?: string[]) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...(cookies ? { 'Set-Cookie': cookies } : {}) });
  response.end(JSON.stringify(data));
}

const sessionCookie = `session=${SESSION}; Path=/; HttpOnly; SameSite=Lax`;
const profile = (id: number | string = 7) => ({ success: true, data: { id, quota: 25_000_000, used_quota: 2_500_000, checked_in: true } });

async function fixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void | Promise<void>, browser = false) {
  const provider = structuredClone(PROVIDERS.agentrouter);
  // Keep the real builtin name, paths, quota units and no-sign-in behavior.
  // WAF transport is covered separately; a focused browser case verifies the
  // saved-Session balance read needed to calculate password-login rewards.
  provider.bypass_method = browser ? 'waf_cookies' : null;
  provider.waf_cookie_names = browser ? ['acw_tc'] : [];
  const observed: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    let bodyText = '';
    for await (const part of request) bodyText += part;
    let body: unknown;
    try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = bodyText; }
    observed.push({ path: new URL(request.url!, 'http://localhost').pathname, method: request.method!,
      cookie: request.headers.cookie || '', user: String(request.headers[provider.api_user_key] || ''),
      bearer: request.headers.authorization || '', body });
    try { await handler(request, response, body); } catch { request.socket.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  provider.domain = `http://127.0.0.1:${address.port}`;
  const engine = new CheckinEngine({ providers: { agentrouter: provider },
    config: loadConfig({}, { testMode: true, defaultProxyUrl: undefined }) });
  t.after(async () => {
    await engine.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { engine, observed, provider };
}

test('Agent password compares a fresh saved-Session balance before clearing it and logging in', async t => {
  const f = await fixture(t, (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/login') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'acw_tc=fixture-waf; Path=/; SameSite=Lax' });
      response.end('<!doctype html><title>Fixture</title>');
      return;
    }
    if (path === '/api/user/login' && request.method === 'POST') {
      assert.equal(String(request.headers.cookie).includes(OLD_SESSION), false);
      assert.equal(String(request.headers.cookie).includes('acw_tc=fixture-waf'), true);
      return json(response, 200, { success: true, data: { id: 7, checked_in: true } }, [sessionCookie]);
    }
    if (path === '/api/user/self') {
      if (String(request.headers.cookie).includes(OLD_SESSION)) return json(response, 200, {
        success: true, data: { id: 7, quota: 20_000_000, used_quota: 2_500_000 },
      });
      return json(response, 200, profile());
    }
    response.writeHead(404); response.end();
  }, true);

  const result = await f.engine.run(row(), credentials('agent-alias', { api_user: '7' }));
  assert.equal(result.status, 'success');
  assert.equal(result.before_balance, 40);
  assert.equal(result.after_balance, 50);
  assert.equal(result.reward, 10);
  const userRequests = f.observed.filter(request => request.path.startsWith('/api/user'));
  assert.deepEqual(userRequests.map(request => [request.path, request.method]), [
    ['/api/user/self', 'GET'], ['/api/user/login', 'POST'], ['/api/user/self', 'GET'],
  ]);
  assert.equal(userRequests[0].cookie.includes(OLD_SESSION), true);
  assert.equal(userRequests[1].cookie.includes(OLD_SESSION), false);
  assert.equal(userRequests[2].cookie.includes(SESSION), true);
});

test('Agent password still completes when the saved Session cannot provide a fresh baseline', async t => {
  const f = await fixture(t, (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/login') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'acw_tc=fixture-waf; Path=/; SameSite=Lax' });
      response.end('<!doctype html><title>Fixture</title>');
      return;
    }
    if (path === '/api/user/login' && request.method === 'POST') return json(response, 200,
      { success: true, data: { id: 7, checked_in: true } }, [sessionCookie]);
    if (path === '/api/user/self' && String(request.headers.cookie).includes(OLD_SESSION)) return json(response, 401, { success: false });
    if (path === '/api/user/self') return json(response, 200, profile());
    response.writeHead(404); response.end();
  }, true);

  const result = await f.engine.run(row(), credentials('agent-alias', { api_user: '7' }));
  assert.equal(result.status, 'success');
  assert.equal(result.after_balance, 50);
  assert.equal(result.reward, null);
  assert.match(result.message, /奖励金额暂未确认/);
  assert.equal(f.observed.filter(request => request.path === '/api/user/login').length, 1);
  assert.equal(f.observed.filter(request => request.path === '/api/user/self').length, 2);
});

for (const identity of ['agent-alias', 'agent-fixture@example.test']) {
  test(`Agent password submits ${identity.includes('@') ? 'email' : 'username'} in username and derives Session and ID`, async t => {
    const f = await fixture(t, (request, response) => {
      if (request.method === 'POST') return json(response, 200, { success: true, data: { id: 7, checked_in: false } }, [sessionCookie]);
      json(response, 200, profile());
    });
    const result = await f.engine.run(row(), credentials(identity));
    assert.equal(result.status, 'synced');
    assert.deepEqual(f.observed.map(request => [request.path, request.method]), [['/api/user/login', 'POST'], ['/api/user/self', 'GET']]);
    assert.deepEqual(f.observed[0].body, { username: identity, password: PASSWORD });
    assert.equal(f.observed[0].cookie, '');
    assert.equal(f.observed[0].user, '');
    assert.equal(f.observed[0].bearer, '');
    assert.equal(f.observed[1].cookie, 'session=' + SESSION);
    assert.equal(f.observed[1].user, '7');
    assert.equal(f.observed[1].bearer, '');
    assert.equal(result._session_update?.session, SESSION);
    assert.equal(result._session_update?.api_user, '7');
    assert.equal(result.after_balance, 50);
    assert.equal(result.used_quota, 5);
    assert.equal(result.total_quota, 55);
    assert.equal(result.message.includes(PASSWORD), false);
    assert.equal(result.message.includes(SESSION), false);
  });
}

for (const checked of [true, false, undefined, 'true', 1] as const) {
  test(`Agent password reward depends on exact login checked_in (${typeof checked === 'string' ? JSON.stringify(checked) : String(checked)}), never the self flag`, async t => {
    const f = await fixture(t, (request, response) => {
      if (request.method === 'POST') return json(response, 200, { success: true, data: { id: 7,
        quota: 0, used_quota: 0, ...(checked !== undefined ? { checked_in: checked } : {}) } }, [sessionCookie]);
      // The self endpoint always carries a true flag; it is not login evidence.
      json(response, 200, profile());
    });
    const result = await f.engine.run(row(), credentials());
    assert.equal(result.status, checked === true ? 'success' : 'synced');
    assert.equal(result.reward, checked === false ? 0 : null);
    assert.equal(result.before_balance, undefined, 'the stored old balance is not a live pre-login balance');
    assert.equal(result.after_balance, 50, 'money comes from the fresh self response');
    assert.equal(result._session_update?.session, SESSION);
    assert.equal(f.observed.filter(request => request.method === 'POST').length, 1);
    assert.equal(f.observed.some(request => /sign[-_]?in|check[-_]?in/.test(request.path)), false);
    if (checked === true) assert.match(result.message, /奖励金额暂未确认/);
  });
}

for (const cookies of [undefined, [`session=${SESSION}; Domain=unrelated.example; Path=/; HttpOnly`]]) {
  test(`Agent password requires a newly issued in-scope Session (${cookies ? 'wrong domain' : 'no cookie'})`, async t => {
    const f = await fixture(t, (_request, response) => json(response, 200, { success: true, data: { id: 7, checked_in: true } }, cookies));
    const result = await f.engine.run(row(), credentials());
    assert.equal(result.status, 'manual_required');
    assert.equal(result._session_update, undefined);
    assert.equal(result.after_balance, undefined);
    assert.match(result.message, /未签发有效站点 Session/);
    assert.deepEqual(f.observed.map(request => [request.path, request.method]), [['/api/user/login', 'POST']]);
    assert.equal(f.observed[0].cookie.includes(OLD_SESSION), false);
  });
}

test('Agent password refuses a login ID different from the previously verified account', async t => {
  const f = await fixture(t, (_request, response) => json(response, 200, { success: true, data: { id: 8, checked_in: true } }, [sessionCookie]));
  const result = await f.engine.run(row(), credentials('agent-alias', { api_user: '7' }));
  assert.equal(result.status, 'manual_required');
  assert.equal(result._session_update, undefined);
  assert.equal(result.after_balance, undefined);
  assert.equal(f.observed.length, 1);
  assert.match(result.message, /身份不一致/);
});

test('Agent password requires the fresh self ID to match the new login before saving Session or money', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'POST') return json(response, 200, { success: true, data: { id: 7, checked_in: true } }, [sessionCookie]);
    json(response, 200, profile(8));
  });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'failed');
  assert.equal(result._session_update, undefined);
  assert.equal(result.after_balance, undefined);
  assert.equal(result.reward, null);
  assert.match(result.message, /身份.*不一致/);
  assert.deepEqual(f.observed.map(request => [request.path, request.method]), [['/api/user/login', 'POST'], ['/api/user/self', 'GET']]);
});

test('Agent password never retries an unknown login POST or persists a credential update', async t => {
  const f = await fixture(t, (request, _response) => { request.socket.destroy(); });
  const result = await f.engine.run(row(), credentials());
  assert.equal(result.status, 'failed');
  assert.equal(result._session_update, undefined);
  assert.equal(result.after_balance, undefined);
  assert.equal(result.reward, null);
  assert.match(result.message, /停止自动重试/);
  assert.deepEqual(f.observed.map(request => [request.path, request.method]), [['/api/user/login', 'POST']]);
});

for (const protection of ['html', 'captcha_json'] as const) {
  test(`Agent password does not bypass ${protection} login verification or proceed to self`, async t => {
    const f = await fixture(t, (_request, response) => {
      if (protection === 'html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h1>滑动验证</h1><p>aliyun_waf: verification required</p>');
      } else json(response, 200, { success: false, message: 'Turnstile verification required' });
    });
    const result = await f.engine.run(row(), credentials());
    assert.equal(result.status, 'manual_required');
    assert.equal(result._session_update, undefined);
    assert.equal(result.after_balance, undefined);
    assert.equal(result.reward, null);
    assert.match(result.message, /验证码或二次验证/);
    assert.deepEqual(f.observed.map(request => [request.path, request.method]), [['/api/user/login', 'POST']]);
    assert.equal(f.observed.some(request => /turnstile|captcha|oauth/.test(request.path)), false);
  });
}
