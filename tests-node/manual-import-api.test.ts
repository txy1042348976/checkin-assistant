import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/main.js';
import { PROVIDERS } from '../server/providers.js';

const SESSION = 'isolated-manual-private-session';
const BODY = { name: '手填账号', provider: 'anyrouter', session: SESSION, api_user: '7', interval_hours: 6, request_id: 'a'.repeat(32) };

async function fixture(t: test.TestContext) {
  const observed: { method: string; path: string; cookie: string; user: string }[] = [];
  const state = { delay: 0 };
  const site = createServer((request, response) => {
    const endpoint = new URL(request.url!, 'http://127.0.0.1').pathname;
    observed.push({ method: request.method!, path: endpoint, cookie: request.headers.cookie || '', user: String(request.headers['new-api-user'] || '') });
    const status = request.method !== 'GET' || endpoint !== '/api/user/self' ? 404
      : request.headers.cookie?.includes('invalid-fixture-session') ? 401 : 200;
    setTimeout(() => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { success: true, data: { id: 7, username: 'fixture', quota: 25_000_000, used_quota: 0 } }
        : { success: false, message: 'fixture-rejected' }));
    }, state.delay);
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteAddress = site.address(); assert.ok(siteAddress && typeof siteAddress !== 'string');
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-manual-import-api-')); mkdirSync(path.join(directory, 'data'));
  const providers = structuredClone(PROVIDERS); providers.anyrouter.domain = `http://127.0.0.1:${siteAddress.port}`;
  const runtime = await createApp({ providers, startScheduler: false,
    config: loadConfig({}, { dataDir: path.join(directory, 'data'), adminPassword: 'Fixture-Secure-2026!', testMode: true }) });
  const server = createServer(runtime.app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections(); site.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => site.close(() => resolve()))]);
    await runtime.close(); rmSync(directory, { recursive: true, force: true });
  });
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Fixture-Secure-2026!' }) });
  assert.equal(login.status, 200); const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const csrf = String((await fetch(origin + '/api/bootstrap', { headers: { cookie } }).then(response => response.json())).csrf_token);
  const post = async (body: unknown, headers: Record<string, string> = {}, route = '/api/accounts/import') => {
    const response = await fetch(origin + route, { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    return { status: response.status, data: await response.json() };
  };
  return { runtime, origin, observed, state, cookie, csrf, post };
}

test('manual import authenticates and checks CSRF/origin before any site verification or save', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(BODY, { cookie: '' })).status, 401);
  assert.equal((await f.post(BODY, { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.post(BODY, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.post(BODY, { 'content-type': 'text/plain' })).status, 403);
  assert.deepEqual(f.observed, []); assert.equal(f.runtime.store.accounts().length, 0);
});

test('manual import verifies one read-only identity, saves encrypted credentials and replays a successful request id', async t => {
  const f = await fixture(t), created = await f.post(BODY);
  assert.equal(created.status, 201); assert.equal(created.data.status, 'success');
  const id = created.data.account_id; assert.ok(Number.isSafeInteger(id)); assert.equal(created.data.connection, undefined);
  assert.deepEqual(f.observed, [{ method: 'GET', path: '/api/user/self', cookie: 'session=' + SESSION, user: '7' }]);
  const account = f.runtime.store.account(id)!; assert.equal(account.balance, 50);
  assert.equal(f.runtime.store.credentials(account).session, SESSION); assert.equal(account.encrypted.includes(SESSION), false);
  const repeated = await f.post(BODY); assert.equal(repeated.status, 201); assert.equal(repeated.data.account_id, id);
  assert.equal(f.observed.length, 1); assert.equal(f.runtime.store.accounts().length, 1); assert.equal(f.runtime.store.runs().length, 0);
  const changed = await f.post({ ...BODY, session: 'another-valid-isolated-session' }); assert.equal(changed.status, 409);
  assert.equal(f.observed.length, 1); assert.equal(f.runtime.store.accounts().length, 1);
  const bootstrap = await fetch(f.origin + '/api/bootstrap', { headers: { cookie: f.cookie } }).then(response => response.json());
  assert.equal(bootstrap.authorization, null); assert.equal(JSON.stringify(bootstrap).includes(SESSION), false);
});

test('manual import rejects unsupported fields and invalid request identity, provider, range and credentials before site access', async t => {
  const f = await fixture(t);
  const { request_id: _requestId, ...missingRequestId } = BODY;
  for (const body of [missingRequestId, { ...BODY, request_id: 'A'.repeat(32) }, { ...BODY, request_id: 'a'.repeat(31) },
    { ...BODY, name: '' }, { ...BODY, name: 'x'.repeat(41) }, { ...BODY, provider: 'missing' },
    { ...BODY, interval_hours: 0 }, { ...BODY, interval_hours: 169 }, { ...BODY, interval_hours: '6' },
    { ...BODY, account_id: 0 }, { ...BODY, account_id: true }, { ...BODY, proxy: 'direct' },
    { ...BODY, oauth_cookies: [] }, { ...BODY, site_cookies: [] }, { ...BODY, auth_mode: 'session' },
    { ...BODY, session: 'bad\nheader' }, { ...BODY, api_user: '0' }]) {
    assert.equal((await f.post(body)).status, 422);
  }
  assert.deepEqual(f.observed, []); assert.equal(f.runtime.store.accounts().length, 0); assert.equal(f.runtime.store.runs().length, 0);
});

test('manual update preserves an omitted proxy and rejects replacing an existing account with a different identity', async t => {
  const f = await fixture(t);
  const id = f.runtime.store.addAccount({ name: 'old', provider: 'anyrouter', auth_mode: 'session', enabled: false, interval_hours: 6,
    session: 'original-fixture-session', api_user: '7', proxy: { mode: 'direct' } });
  const invalid = await f.post({ ...BODY, account_id: id, api_user: '8', request_id: 'b'.repeat(32) });
  assert.equal(invalid.status, 422); assert.deepEqual(f.observed, []);
  assert.equal(f.runtime.store.credentials(f.runtime.store.account(id)!).session, 'original-fixture-session');
  const updated = await f.post({ ...BODY, account_id: id, interval_hours: 12, request_id: 'c'.repeat(32) });
  assert.equal(updated.status, 200); assert.equal(updated.data.account_id, id); assert.equal(f.runtime.store.accounts().length, 1);
  const row = f.runtime.store.account(id)!; assert.equal(row.interval_hours, 12);
  assert.deepEqual(f.runtime.store.credentials(row).proxy, { mode: 'direct' }); assert.equal(f.runtime.store.runs().length, 0);
});

test('concurrent identical manual requests share one verification and a failed check leaves no active authorization', async t => {
  const f = await fixture(t); f.state.delay = 75;
  const results = await Promise.all([f.post(BODY), f.post(BODY)]);
  for (const result of results) { assert.equal(result.status, 201); assert.equal(result.data.status, 'success'); }
  assert.equal(results[0].data.account_id, results[1].data.account_id); assert.equal(f.observed.length, 1);
  const invalid = await f.post({ ...BODY, session: 'invalid-fixture-session', request_id: 'd'.repeat(32) });
  assert.equal(invalid.status, 422); assert.equal(f.runtime.store.accounts().length, 1);
  const bootstrap = await fetch(f.origin + '/api/bootstrap', { headers: { cookie: f.cookie } }).then(response => response.json());
  assert.equal(bootstrap.authorization, null); assert.equal(f.runtime.imports.current(), null); assert.equal(f.runtime.store.runs().length, 0);
});

test('password account save accepts the site username or email without Session/ID and performs no immediate login or check-in', async t => {
  const f = await fixture(t);
  const result = await f.post({ name: 'Agent 密码账号', provider: 'agentrouter', auth_mode: 'password', email: 'fixture-user@example.com',
    password: 'Fixture-Site-Password!', interval_hours: 6 }, {}, '/api/accounts');
  assert.equal(result.status, 201); assert.equal(f.runtime.store.accounts().length, 1);
  assert.deepEqual(f.observed, []); assert.equal(f.runtime.store.runs().length, 0);
  const credentials = f.runtime.store.credentials(f.runtime.store.account(result.data.id)!);
  assert.equal(credentials.email, 'fixture-user@example.com'); assert.equal(credentials.session, undefined); assert.equal(credentials.api_user, undefined);
});
