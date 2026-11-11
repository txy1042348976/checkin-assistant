import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/main.js';

async function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-retired-connector-'));
  const resources = path.join(directory, 'resources'), connector = path.join(resources, 'local-connector');
  mkdirSync(connector, { recursive: true });
  // Even a complete historical connector in the repository must not become a download.
  for (const file of ['connector.mjs', 'protocol.mjs', 'cdp.mjs', 'ui.mjs', 'launch.command', 'launch.cmd', 'launch.sh', 'README.md']) {
    writeFileSync(path.join(connector, file), 'historical-connector-source\n');
  }
  writeFileSync(path.join(connector, '.env'), 'fixture-private-environment');
  const runtime = await createApp({ startScheduler: false,
    config: loadConfig({}, { dataDir: path.join(directory, 'data'), resourceRoot: resources,
      adminPassword: 'Fixture-Secure-2026!', testMode: true }) });
  const server = createServer(runtime.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); rmSync(directory, { recursive: true, force: true });
  });
  const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Fixture-Secure-2026!' }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return { runtime, origin, cookie };
}

test('bootstrap offers manual credentials without an authorization queue or extension and connector metadata', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/bootstrap', { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200);
  const bootstrap = await response.json();
  assert.equal(bootstrap.web.authorization_mode, 'manual'); assert.equal(bootstrap.web.remote_browser, false);
  assert.equal(bootstrap.authorization, null); assert.equal(bootstrap.web.extension_url, undefined);
  assert.equal(bootstrap.web.connector_url, undefined); assert.equal(bootstrap.web.connector_version, undefined);
  assert.deepEqual(bootstrap.engine.login_methods, ['password', 'session']);
  assert.equal(bootstrap.engine.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(f.runtime.store.accounts().length, 0); assert.equal(f.runtime.store.runs().length, 0);
});

test('retired connector downloads stay unavailable and legacy authorization APIs and extension downloads return 410', async t => {
  const f = await fixture(t), route = '/downloads/checkin-assistant-local-connector.zip';
  const id = 'a'.repeat(32), ticket = 'A'.repeat(43);
  const callers: Record<string, string>[] = [{}, { cookie: f.cookie },
    { authorization: `Bearer ${ticket}` }];
  for (const headers of callers) {
    const response = await fetch(f.origin + route, { headers });
    assert.equal(response.status, 404); assert.equal(response.headers.get('content-type')?.includes('application/zip'), false);
    const text = await response.text(); assert.equal(text.includes('historical-connector-source'), false); assert.equal(text.includes('fixture-private'), false);
  }
  const retired = ['/api/login/start', `/api/login/${id}`, `/api/login/${id}/import`, `/api/browser-import/${id}`,
    '/downloads/checkin-assistant-browser-extension.zip'];
  for (const endpoint of retired) for (const method of ['GET', 'POST', 'HEAD']) for (const caller of callers) {
    const response = await fetch(f.origin + endpoint, { method,
      headers: { ...caller, ...(caller.authorization ? { origin: `chrome-extension://${'a'.repeat(32)}` } : {}),
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify({ provider: 'anyrouter', method: 'manual', name: '退役接口测试',
        interval_hours: 6, session: 'format-valid-retired-session', api_user: '7' }) } : {}) });
    assert.equal(response.status, 410, `${method} ${endpoint} remains retired regardless of cookies or a legacy Bearer`);
    assert.equal(response.headers.get('content-type')?.includes('application/zip'), false);
    const text = await response.text(); assert.equal(text.includes(ticket), false);
    assert.equal(text.includes('historical-connector-source'), false); assert.equal(text.includes('fixture-private'), false);
  }
  assert.equal(Number(f.runtime.store.db.prepare('SELECT COUNT(*) AS count FROM browser_imports').get()!.count), 0);
  assert.equal(f.runtime.store.accounts().length, 0); assert.equal(f.runtime.store.runs().length, 0);
});
