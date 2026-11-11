import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { createApp, startServer } from '../server/main.js';
import { PROVIDERS } from '../server/providers.js';
import { Scheduler } from '../server/scheduler.js';

async function fixture(t: test.TestContext, manualSetup = false) {
  const observed: { method: string; cookie: string }[] = [];
  const site = createServer((req, res) => {
    observed.push({ method: req.method!, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, data: { id: 7, username: 'isolated-fixture', quota: 5000000, used_quota: 0 } }));
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteAddress = site.address(); assert.ok(siteAddress && typeof siteAddress !== 'string');
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-api-'));
  const providers = structuredClone(PROVIDERS);
  providers.anyrouter.domain = `http://127.0.0.1:${siteAddress.port}`;
  const runtime = await createApp({ providers, startScheduler: false,
    config: loadConfig({}, { dataDir: directory, adminPassword: manualSetup ? undefined : 'Fixture-Secure-2026!', testMode: true }) });
  const server = createServer(runtime.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections(); site.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => site.close(() => resolve()))]);
    await runtime.close(); rmSync(directory, { recursive: true, force: true });
  });
  if (manualSetup) {
    const status = await fetch(url + '/api/auth/status').then(response => response.json());
    assert.equal(status.setup_required, true); assert.equal(status.configured, false); assert.equal(status.authenticated, false);
    assert.equal(existsSync(runtime.security.setupTokenPath), false);
    assert.equal((await fetch(url + '/api/bootstrap')).status, 401);
  }
  const username = manualSetup ? 'workspace-owner' : 'admin';
  const login = await fetch(url + (manualSetup ? '/api/auth/setup' : '/api/auth/login'), { method: 'POST', headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'Fixture-Secure-2026!' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const bootstrap = await fetch(url + '/api/bootstrap', { headers: { cookie } }).then(response => response.json());
  const csrf = String(bootstrap.csrf_token);
  const call = (route: string, body?: unknown, headers: Record<string, string> = {}) => fetch(url + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: url, 'x-csrf-token': csrf,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { runtime, url, cookie, csrf, call, observed, username };
}

test('actual Node app creates the first chosen administrator without environment credentials or a token, then uses normal login', async t => {
  const f = await fixture(t, true);
  assert.equal(f.runtime.config.adminPassword, undefined);
  assert.equal(f.runtime.store.db.prepare('SELECT username FROM web_admin WHERE id=1').get()!.username, f.username);
  const configured = await f.call('/api/auth/status').then(response => response.json());
  assert.equal(configured.authenticated, true); assert.equal(configured.setup_required, false); assert.equal(configured.username, f.username);
  const bootstrap = await f.call('/api/bootstrap'); assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).web.authorization_mode, 'manual');
  const loggedOut = await f.call('/api/auth/logout', {}); assert.equal(loggedOut.status, 200);
  assert.equal((await f.call('/api/bootstrap')).status, 401);
  const status = await fetch(f.url + '/api/auth/status').then(response => response.json());
  assert.equal(status.configured, true); assert.equal(status.setup_required, false); assert.equal(status.authenticated, false);
  const submit = (route: string, username: string, password: string) => fetch(f.url + route, {
    method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  assert.equal((await submit('/api/auth/setup', 'replacement-owner', 'Different-Secure-2026!')).status, 409);
  assert.equal((await submit('/api/auth/login', 'admin', 'Fixture-Secure-2026!')).status, 401);
  assert.equal((await submit('/api/auth/login', f.username, 'Different-Secure-2026!')).status, 401);
  const login = await submit('/api/auth/login', f.username, 'Fixture-Secure-2026!');
  assert.equal(login.status, 200); assert.equal((await login.json()).username, f.username);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { cookie } })).status, 200);
  assert.equal(f.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get()!.n, 1);
  assert.equal(existsSync(f.runtime.security.setupTokenPath), false); assert.deepEqual(f.observed, []);
});

test('actual Node API separates public health from administrator access and retires browser control routes', async t => {
  const f = await fixture(t);
  const health = await fetch(f.url + '/api/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).runtime, 'node');
  assert.equal((await fetch(f.url + '/api/bootstrap')).status, 401);
  for (const route of ['/browser', '/api/browser/state', '/API/bootstrap', '/api/bootstrap/']) {
    const response = await f.call(route); assert.equal(response.status, 404);
  }
  assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { cookie: f.cookie } })).headers.get('x-frame-options'), 'DENY');
  assert.equal(f.runtime.store.accounts().length, 0);
});

test('dedicated import bearer authorizes one read-only save and cannot access the administrator API', async t => {
  const f = await fixture(t);
  const start = await f.call('/api/login/start', { provider: 'anyrouter', method: 'manual', name: '本地 API 账号', interval_hours: 6 });
  assert.equal(start.status, 202);
  const pending = await start.json();
  const route = '/api/browser-import/' + pending.id;
  const auth = 'Bearer ' + pending.connection.ticket;
  assert.equal((await fetch(f.url + route + '?ticket=' + pending.connection.ticket)).status, 401);
  assert.equal((await fetch(f.url + '/api/bootstrap', { headers: { authorization: auth } })).status, 401);
  assert.equal((await fetch(f.url + route, { headers: { authorization: auth, origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(f.url + route, { method: 'HEAD', headers: { authorization: auth } })).status, 405);
  const view = await fetch(f.url + route, { headers: { authorization: auth, origin: 'chrome-extension://' + 'a'.repeat(32) } });
  assert.equal(view.status, 200);
  const detail = await view.json(); assert.equal(detail.connection, undefined); assert.equal(detail.provider.id, 'anyrouter');
  const badFormat = await fetch(f.url + route, { method: 'POST', headers: { authorization: auth, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(badFormat.status, 415); assert.deepEqual(f.observed, []);
  const saved = await fetch(f.url + route, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'fixture-site-private', api_user: '7' }) });
  assert.equal(saved.status, 200);
  const complete = await saved.json(); assert.equal(complete.status, 'success'); assert.equal(complete.connection, undefined);
  assert.deepEqual(f.observed, [{ method: 'GET', cookie: 'session=fixture-site-private' }]);
  assert.equal(f.runtime.store.accounts().length, 1); assert.equal(f.runtime.store.runs().length, 0);
  assert.equal((await fetch(f.url + route, { headers: { authorization: auth } })).status, 410);
  assert.equal(JSON.stringify(await f.call('/api/bootstrap').then(response => response.json())).includes('fixture-site-private'), false);
});

test('actual route integration applies authentication limits before parsing and preserves proxy secrets on reauthorization', async t => {
  const f = await fixture(t);
  const large = await fetch(f.url + '/API/auth/login', { method: 'POST', headers: { origin: f.url, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(9000) }) });
  assert.equal(large.status, 413);
  const protectedRoute = await fetch(f.url + '/api/login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' });
  assert.equal(protectedRoute.status, 401);
  const id = f.runtime.store.addAccount({ name: '原代理账号', provider: 'anyrouter', auth_mode: 'session', enabled: false, interval_hours: 6,
    session: 'fixture-original-session', api_user: '7', proxy: { mode: 'custom', server: 'http://127.0.0.1:9888', authenticate: true, username: 'fixture-user', password: 'fixture-proxy-private' } });
  const response = await f.call('/api/login/start', { provider: 'anyrouter', method: 'manual', account_id: id, interval_hours: 6,
    proxy: { mode: 'custom', server: 'http://127.0.0.1:9888', authenticate: true, username: 'fixture-user' } });
  assert.equal(response.status, 202);
  const pending = await response.json();
  const row = f.runtime.store.db.prepare('SELECT encrypted_context FROM browser_imports WHERE id=?').get(pending.id)!;
  const context = f.runtime.store.decryptCredentials(String(row.encrypted_context));
  assert.equal(context.proxy?.password, 'fixture-proxy-private');
  assert.equal(JSON.stringify(pending).includes('fixture-proxy-private'), false);
  assert.equal(f.runtime.imports.cancel(pending.id), true); assert.deepEqual(f.observed, []);
});

test('an occupied server port fails without launching background scheduling and closes the new runtime', async t => {
  const f = await fixture(t);
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-bind-failure-'));
  const config = loadConfig({}, { dataDir: directory, host: '127.0.0.1', port: Number(new URL(f.url).port),
    adminPassword: 'Fixture-Secure-2026!', testMode: true });
  const start = Scheduler.prototype.start, close = Scheduler.prototype.close;
  let started = 0, closed = 0;
  const scheduling: Scheduler[] = [];
  Scheduler.prototype.start = function () { started++; scheduling.push(this); start.call(this); };
  Scheduler.prototype.close = async function () { closed++; await close.call(this); };
  try {
    await assert.rejects(startServer(config), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EADDRINUSE');
    assert.equal(started, 0); assert.equal(closed, 1);
  } finally {
    Scheduler.prototype.start = start; Scheduler.prototype.close = close;
    await Promise.all(scheduling.map(scheduler => close.call(scheduler)));
    rmSync(directory, { recursive: true, force: true });
  }
});
