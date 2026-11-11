import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ACCOUNT_BACKUP_FORMAT, AccountTransfers, ENCRYPTED_ACCOUNT_BACKUP_FORMAT, MAX_ACCOUNT_TRANSFER_BYTES,
  type EncryptedAccountBackup, type PortableAccount } from '../server/account-transfer.js';
import { loadConfig } from '../server/config.js';
import { HttpError } from '../server/errors.js';
import { createApp } from '../server/main.js';
import { PROVIDERS, loadCustomProviders, parseProviderInput, providerFromConfig } from '../server/providers.js';
import { Store } from '../server/store.js';
import type { AccountInput, CookieData, Credentials, ProviderInput } from '../server/types.js';

const BACKUP_PASSWORD = 'Fixture-backup-password-2026!';
const SESSION = 'isolated-transfer-private-session';
const SITE_PASSWORD = 'Isolated-site-private-password!';
const PROXY_PASSWORD = 'fixture:proxy-private-password';
const REFRESH = 'isolated-transfer-private-refresh';
const OAUTH = 'isolated-transfer-private-upstream';
const LOGIN = 'CaseSensitive.Login@Example.test';
const future = () => Math.floor(Date.now() / 1000) + 86400;
const requestId = (number: number) => number.toString(16).padStart(32, '0');
const status = (number: number) => (error: unknown) => error instanceof HttpError && error.status === number;

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-account-transfer-'));
  const providers = structuredClone(PROVIDERS);
  let store = new Store({ dataDir: directory, providers, timezone: 'Asia/Shanghai' });
  let transfers = new AccountTransfers(store, providers);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, providers, get store() { return store; }, get transfers() { return transfers; },
    add(data: Partial<AccountInput> = {}) {
      return store.addAccount({ name: '隔离文件账号', provider: 'anyrouter', auth_mode: 'session', enabled: true,
        interval_hours: 6, session: SESSION, api_user: '7', ...data });
    },
    provider(id: string, config: ProviderInput, active = true) {
      store.saveProvider(id, config, active); providers[id] = providerFromConfig(id, config, active);
    },
    restart() {
      store.close(); store = new Store({ dataDir: directory, providers, timezone: 'Asia/Shanghai' });
      loadCustomProviders(store.providerConfigs(), providers); transfers = new AccountTransfers(store, providers);
    } };
}

function account(overrides: Partial<PortableAccount> = {}): PortableAccount {
  return { name: '文件账号', provider: 'anyrouter', auth_mode: 'session', enabled: true, interval_hours: 6,
    login_via: 'manual', credentials: { session: SESSION, api_user: '7' }, ...overrides };
}

function file(accounts: unknown[] = [account()], providers: unknown[] = []) {
  return { format: ACCOUNT_BACKUP_FORMAT, version: 1, exported_at: '2026-11-11T00:00:00.000Z', accounts, providers };
}

function custom(domain = 'https://transfer.fixture.example', overrides: Partial<ProviderInput> = {}): ProviderInput {
  return parseProviderInput({ name: '文件自定义站点', domain, ...overrides });
}

function rowCount(store: Store, table: string): number {
  assert.ok(['accounts', 'custom_providers', 'account_file_imports', 'runs'].includes(table));
  return Number(store.db.prepare('SELECT COUNT(*) AS count FROM ' + table).get()!.count);
}

function signal() {
  let notify!: () => void;
  const promise = new Promise<void>(resolve => { notify = resolve; });
  return { promise, notify };
}

async function apiFixture(t: test.TestContext) {
  const observed: string[] = [];
  const site = createServer((request, response) => {
    observed.push(request.method + ' ' + request.url);
    response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"success":false}');
  });
  await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
  const siteAddress = site.address(); assert.ok(siteAddress && typeof siteAddress !== 'string');
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-account-transfer-http-'));
  const providers = structuredClone(PROVIDERS);
  for (const provider of Object.values(providers)) provider.domain = `http://127.0.0.1:${siteAddress.port}`;
  const runtime = await createApp({ providers, startScheduler: false,
    config: loadConfig({}, { dataDir: directory, adminPassword: 'Fixture-Secure-2026!', testMode: true }) });
  const server = createServer(runtime.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections(); site.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => site.close(() => resolve()))]);
    await runtime.close(); rmSync(directory, { recursive: true, force: true });
  });
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Fixture-Secure-2026!' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const csrf = String((await fetch(origin + '/api/bootstrap', { headers: { cookie } }).then(response => response.json())).csrf_token);
  const post = async (route: string, body: unknown, headers: Record<string, string> = {}, abort?: AbortSignal) => {
    const response = await fetch(origin + route, { method: 'POST', headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: abort ?? AbortSignal.timeout(30000) });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  return { directory, runtime, origin, cookie, csrf, observed, post };
}

test('plain account export selects a consistent portable snapshot without local IDs, balances, runs or administrator data', async t => {
  const source = fixture(t), target = fixture(t);
  const config = custom(); source.provider('custom_source', config); source.provider('custom_unused', custom('https://unused.fixture.example'));
  const passwordId = source.add({ name: '站内密码', provider: 'agentrouter', auth_mode: 'password', email: LOGIN, password: SITE_PASSWORD,
    session: 'isolated-password-cache', api_user: '9', interval_hours: 12, login_via: 'password' });
  const sessionId = source.add({ name: '自定义 Session', provider: 'custom_source', api_user: '11', enabled: false });
  source.add({ name: '未选账号', api_user: '12' });
  const runId = source.store.beginRun(source.store.account(passwordId)!, 'fixture');
  source.store.finishRun(runId, passwordId, { status: 'success', message: 'fixture', before_balance: 40, after_balance: 50, reward: 10 });
  const backup = await source.transfers.exportBackup({ account_ids: [passwordId, sessionId], encrypted: false });
  assert.equal(backup.format, ACCOUNT_BACKUP_FORMAT); assert.ok(backup.format === ACCOUNT_BACKUP_FORMAT);
  assert.deepEqual(backup.accounts.map(row => row.name), ['站内密码', '自定义 Session']);
  assert.deepEqual(backup.providers, [{ id: 'custom_source', config, active: true }]);
  assert.equal(backup.accounts[0].credentials.email, LOGIN);
  const serialized = JSON.stringify(backup);
  for (const excluded of ['"id":' + passwordId, '"balance"', '"status"', '"next_run"', '"last_run"', '"runs"', '"settings"', '"encrypted"', 'password_hash']) assert.equal(serialized.includes(excluded), false);
  assert.equal(serialized.includes(readFileSync(source.store.keyPath, 'utf8')), false);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(1) });
  assert.equal(result.imported, 2); assert.equal(result.providers_imported, 1);
  const restored = target.store.accounts().find(row => row.name === '站内密码')!;
  assert.deepEqual(target.store.credentials(restored), backup.accounts[0].credentials);
  assert.equal(restored.enabled, 0); assert.equal(restored.status, 'idle'); assert.equal(restored.balance, null);
  assert.equal(restored.last_run, null); assert.equal(restored.next_run, null); assert.equal(target.store.runs().length, 0);
});

test('encrypted files roundtrip across a new local key with password caches, WAF/OAuth cookies, refresh Token, legacy proxy and custom origin', async t => {
  const source = fixture(t), target = fixture(t);
  const config = custom('https://tokens.fixture.example', { template: 'sub2api', currency: 'CNY' }); source.provider('source_tokens', config);
  source.add({ name: 'Any Session', site_cookies: [{ name: 'acw_tc', value: 'isolated-private-waf', domain: '.anyrouter.top', path: '/', expires: future(), secure: true, httpOnly: true, sameSite: 'Lax' }] });
  source.add({ name: 'Agent Password', provider: 'agentrouter', auth_mode: 'password', email: LOGIN, password: SITE_PASSWORD,
    api_user: '9', session: 'isolated-password-cache', login_via: 'password', proxy: { mode: 'custom', server: `http://ProxyUser:${encodeURIComponent(PROXY_PASSWORD)}@proxy.fixture.example:80` } });
  for (const [method, domain, id] of [['github', '.github.com', '10'], ['linuxdo', '.linux.do', '12']] as const) {
    source.add({ name: 'Agent ' + method, provider: 'agentrouter', api_user: id, login_via: method,
      oauth_cookies: [{ name: 'fixture_upstream', value: OAUTH, domain, path: '/', expires: future(), secure: true, httpOnly: true, sameSite: 'None' }],
      oauth_user_agent: 'Fixture Browser/1.0' });
  }
  source.add({ name: 'Sub Token', provider: 'source_tokens', api_user: '11', refresh_token: REFRESH, proxy: { mode: 'direct' } });
  const canonical = await source.transfers.exportBackup({ encrypted: false }); assert.ok(canonical.format === ACCOUNT_BACKUP_FORMAT);
  const encrypted = await source.transfers.exportBackup({ password: BACKUP_PASSWORD }); assert.ok(encrypted.format === ENCRYPTED_ACCOUNT_BACKUP_FORMAT);
  const again = await source.transfers.exportBackup({ password: BACKUP_PASSWORD }); assert.ok(again.format === ENCRYPTED_ACCOUNT_BACKUP_FORMAT);
  assert.notEqual(encrypted.kdf.salt, again.kdf.salt); assert.notEqual(encrypted.cipher.iv, again.cipher.iv);
  for (const secret of [SESSION, SITE_PASSWORD, LOGIN, PROXY_PASSWORD, REFRESH, OAUTH, BACKUP_PASSWORD]) assert.equal(JSON.stringify(encrypted).includes(secret), false);
  assert.notEqual(readFileSync(source.store.keyPath, 'utf8'), readFileSync(target.store.keyPath, 'utf8'));
  target.add({ name: '已有目标账号', api_user: '101' });
  const before = { accounts: rowCount(target.store, 'accounts'), providers: rowCount(target.store, 'custom_providers'), imports: rowCount(target.store, 'account_file_imports') };
  const preview = await target.transfers.previewBackup({ file: encrypted, password: BACKUP_PASSWORD });
  assert.equal(preview.new_count, 5); assert.equal(preview.error_count, 0); assert.equal(preview.can_import, true);
  assert.deepEqual(preview.providers_to_add, [{ name: config.name, domain: config.domain }]);
  for (const secret of [SESSION, SITE_PASSWORD, LOGIN, PROXY_PASSWORD, REFRESH, OAUTH, BACKUP_PASSWORD]) assert.equal(JSON.stringify(preview).includes(secret), false);
  assert.deepEqual({ accounts: rowCount(target.store, 'accounts'), providers: rowCount(target.store, 'custom_providers'), imports: rowCount(target.store, 'account_file_imports') }, before);
  const result = await target.transfers.importBackup({ file: encrypted, password: BACKUP_PASSWORD, request_id: requestId(2) });
  assert.equal(result.imported, 5); assert.equal(result.skipped, 0); assert.equal(result.providers_imported, 1);
  assert.ok(result.account_ids.every(id => id > 1));
  for (const saved of canonical.accounts) {
    const row = target.store.accounts().find(candidate => candidate.name === saved.name)!;
    assert.deepEqual(target.store.credentials(row), saved.credentials);
    assert.equal(row.enabled, 0); assert.equal(row.status, 'idle'); assert.equal(row.next_run, null);
    assert.equal(row.balance, null); assert.equal(row.used_quota, null); assert.equal(row.has_snapshot, 0);
    if (saved.provider === 'source_tokens') {
      assert.notEqual(row.provider, 'source_tokens'); assert.equal(target.providers[row.provider].domain, config.domain);
    }
  }
  const password = target.store.credentials(target.store.accounts().find(row => row.name === 'Agent Password')!);
  assert.deepEqual(password.proxy, { mode: 'custom', server: 'http://proxy.fixture.example:80', authenticate: true, username: 'ProxyUser', password: PROXY_PASSWORD });
  assert.equal(target.store.runs().length, 0);
  for (const name of [target.store.dbPath, target.store.dbPath + '-wal']) if (existsSync(name)) {
    const bytes = readFileSync(name);
    for (const secret of [SESSION, SITE_PASSWORD, LOGIN, PROXY_PASSWORD, REFRESH, OAUTH, BACKUP_PASSWORD]) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
});

test('wrong passwords and authenticated ciphertext tampering never write an account or expose credential errors', async t => {
  const source = fixture(t), target = fixture(t); source.add();
  const encrypted = await source.transfers.exportBackup({ password: BACKUP_PASSWORD }); assert.ok(encrypted.format === ENCRYPTED_ACCOUNT_BACKUP_FORMAT);
  const tampered = structuredClone(encrypted), bytes = Buffer.from(tampered.data, 'base64'); bytes[0] ^= 1; tampered.data = bytes.toString('base64');
  for (const [backup, password] of [[encrypted, 'Wrong-backup-password!'], [tampered, BACKUP_PASSWORD]] as const) {
    await assert.rejects(target.transfers.previewBackup({ file: backup, password }), error => error instanceof HttpError && error.status === 422
      && error.message === '备份密码不正确或文件已损坏。' && !error.message.includes(SESSION));
    await assert.rejects(target.transfers.importBackup({ file: backup, password, request_id: requestId(3) }), status(422));
  }
  assert.equal(rowCount(target.store, 'accounts'), 0); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
});

test('encrypted envelope parameters and canonical base64 are validated before any caller-controlled KDF cost', async t => {
  const source = fixture(t); source.add();
  const encrypted = await source.transfers.exportBackup({ password: BACKUP_PASSWORD }); assert.ok(encrypted.format === ENCRYPTED_ACCOUNT_BACKUP_FORMAT);
  for (const bad of [{ ...encrypted, version: 2 }, { ...encrypted, kdf: { ...encrypted.kdf, N: 2 ** 30 } },
    { ...encrypted, kdf: { ...encrypted.kdf, p: 100000 } }, { ...encrypted, cipher: { ...encrypted.cipher, name: 'aes-256-cbc' } },
    { ...encrypted, cipher: { ...encrypted.cipher, iv: 'AAAA' } }, { ...encrypted, data: encrypted.data + '\n' },
    { ...encrypted, kdf: { ...encrypted.kdf, maxmem: 1e12 } }]) {
    await assert.rejects(source.transfers.previewBackup({ file: bad, password: BACKUP_PASSWORD }), status(422));
  }
  for (const password of [undefined, '1234567', 'x'.repeat(1025), 12345678]) await assert.rejects(source.transfers.previewBackup({ file: encrypted, password }), status(422));
});

test('backup encryption has bounded asynchronous concurrency and recovers after a busy response', async t => {
  const source = fixture(t); source.add();
  const results = await Promise.allSettled([1, 2, 3].map(() => source.transfers.exportBackup({ password: BACKUP_PASSWORD })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  const rejected = results.find(result => result.status === 'rejected'); assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof HttpError && rejected.reason.status === 429);
  assert.equal((await source.transfers.exportBackup({ password: BACKUP_PASSWORD })).format, ENCRYPTED_ACCOUNT_BACKUP_FORMAT);
});

test('valid duplicate rows bridge known site IDs and password login names across authentication modes without lowercasing', async t => {
  const target = fixture(t);
  target.add({ provider: 'agentrouter', auth_mode: 'password', email: 'Alice', password: SITE_PASSWORD, api_user: undefined, session: undefined });
  const backup = file([
    account({ provider: 'agentrouter', auth_mode: 'password', name: '桥接密码', credentials: { email: 'Alice', password: SITE_PASSWORD, api_user: 7 as unknown as string } }),
    account({ provider: 'agentrouter', name: '桥接 Session', credentials: { session: SESSION, api_user: '0007' } }),
    account({ provider: 'agentrouter', auth_mode: 'password', name: '不同大小写', credentials: { email: 'alice', password: SITE_PASSWORD } }),
    account({ provider: 'agentrouter', auth_mode: 'password', name: '文件内重复', credentials: { email: 'alice', password: 'another-password' } }),
  ]);
  const preview = await target.transfers.previewBackup({ file: backup });
  assert.deepEqual(preview.rows.map(row => row.status), ['duplicate', 'duplicate', 'new', 'duplicate']);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(4) });
  assert.equal(result.imported, 1); assert.equal(result.skipped, 3); assert.equal(target.store.accounts().length, 2);
  assert.equal(target.store.credentials(target.store.account(result.account_ids[0])!).email, 'alice');
});

test('known password login and site ID conflicts are invalid and do not poison other row identities', async t => {
  const target = fixture(t);
  target.add({ provider: 'agentrouter', auth_mode: 'password', email: 'Alice', password: SITE_PASSWORD, api_user: '7' });
  const backup = file([
    account({ provider: 'agentrouter', auth_mode: 'password', credentials: { email: 'Alice', password: SITE_PASSWORD, api_user: '8' } }),
    account({ provider: 'agentrouter', name: '独立 Session', credentials: { session: SESSION, api_user: '8' } }),
  ]);
  const preview = await target.transfers.previewBackup({ file: backup });
  assert.deepEqual(preview.rows.map(row => row.status), ['invalid', 'new']); assert.equal(preview.can_import, false);
  await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(5) }), status(422));
  assert.equal(target.store.accounts().length, 1); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
});

test('a late password identity bridge cannot commit two earlier rows for the same site account', async t => {
  const target = fixture(t);
  const backup = file([
    account({ provider: 'agentrouter', auth_mode: 'password', name: '密码身份', credentials: { email: 'Alice', password: SITE_PASSWORD } }),
    account({ provider: 'agentrouter', name: 'Session 身份', credentials: { session: SESSION, api_user: '7' } }),
    account({ provider: 'agentrouter', auth_mode: 'password', name: '关联身份', credentials: { email: 'Alice', password: SITE_PASSWORD, api_user: '7' } }),
  ]);
  const preview = await target.transfers.previewBackup({ file: backup });
  assert.deepEqual(preview.rows.map(row => row.status), ['new', 'new', 'invalid']); assert.equal(preview.can_import, false);
  assert.match(preview.rows[2].message, /合并或删除重复条目/);
  await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(44) }), status(422));
  assert.equal(target.store.accounts().length, 0); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
  target.add({ provider: 'agentrouter', auth_mode: 'password', email: 'Alice', password: SITE_PASSWORD, api_user: undefined, session: undefined });
  target.add({ provider: 'agentrouter', api_user: '7' });
  const existingBridge = await target.transfers.previewBackup({ file: file([backup.accounts[2]]) });
  assert.equal(existingBridge.rows[0].status, 'invalid'); assert.equal(target.store.accounts().length, 2);
});

test('invalid credentials are validated before duplicate checks and a mixed file is atomic', async t => {
  const target = fixture(t); target.add();
  const config = custom();
  const backup = file([
    account({ credentials: { session: SESSION, api_user: '7', password: 'invalid\u0000password' } }),
    account({ provider: 'source_custom', name: '可导入账号', credentials: { session: SESSION, api_user: '8' } }),
  ], [{ id: 'source_custom', config, active: true }]);
  const preview = await target.transfers.previewBackup({ file: backup });
  assert.deepEqual(preview.rows.map(row => row.status), ['invalid', 'new']); assert.equal(preview.can_import, false);
  assert.equal(JSON.stringify(preview).includes(SESSION), false);
  await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(6) }), status(422));
  assert.equal(target.store.accounts().length, 1); assert.equal(rowCount(target.store, 'custom_providers'), 0); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
});

test('custom provider IDs are file references and cannot bind a foreign origin or overwrite an existing ID', async t => {
  const target = fixture(t), original = custom('https://original.fixture.example'); target.provider('source_id', original);
  const existingId = target.add({ provider: 'source_id', name: '原站账号' });
  const imported = custom('https://different.fixture.example');
  const backup = file([account({ provider: 'source_id' })], [{ id: 'source_id', config: imported, active: true }]);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(7) });
  const row = target.store.account(result.account_ids[0])!;
  assert.notEqual(row.provider, 'source_id'); assert.match(row.provider, /^custom_[a-f0-9]{32}$/);
  assert.equal(target.providers[row.provider].domain, imported.domain); assert.deepEqual(target.store.providerConfigs().find(record => record.id === 'source_id')!.config, original);
  assert.equal(target.store.account(existingId)!.provider, 'source_id'); assert.equal(target.store.accounts().length, 2);
  const missing = await target.transfers.previewBackup({ file: file([account({ provider: 'source_id' })]) });
  assert.equal(missing.rows[0].status, 'invalid');
});

test('equivalent custom configs map to an active existing provider while preserving its name and settings', async t => {
  const target = fixture(t), config = custom();
  target.provider('inactive_old', { ...config, name: '已停用站点' }, false);
  target.provider('active_current', { ...config, name: '现有站点' });
  const backup = file([account({ provider: 'source' })], [{ id: 'source', config, active: true }]);
  const preview = await target.transfers.previewBackup({ file: backup });
  assert.equal(preview.error_count, 0); assert.equal(preview.rows[0].provider_name, '现有站点'); assert.deepEqual(preview.providers_to_add, []);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(8), restore_enabled: true });
  assert.equal(result.providers_imported, 0); assert.equal(target.store.account(result.account_ids[0])!.provider, 'active_current');
  assert.equal(target.store.account(result.account_ids[0])!.enabled, 1);
  assert.equal(target.providers.inactive_old.active, false); assert.equal(target.providers.active_current.display_name, '现有站点');
});

test('an active matching custom config is usable after remove/re-add despite a conflicting inactive tombstone', async t => {
  const target = fixture(t), config = custom();
  target.provider('deleted_old', { ...config, user_info_path: '/api/user/old', quota_per_unit: 1000 }, false);
  target.provider('active_new', config);
  const backup = file([account({ provider: 'source' })], [{ id: 'source', config, active: true }]);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(9) });
  assert.equal(result.providers_imported, 0); assert.equal(target.store.account(result.account_ids[0])!.provider, 'active_new');
  assert.equal(target.providers.deleted_old.user_info_path, '/api/user/old'); assert.equal(target.providers.deleted_old.active, false);
});

test('inactive-only custom matches reject an active source, and inactive sources remain paused without reactivation', async t => {
  const target = fixture(t), config = custom(); target.provider('inactive', config, false);
  const active = file([account({ provider: 'source' })], [{ id: 'source', config, active: true }]);
  const preview = await target.transfers.previewBackup({ file: active }); assert.equal(preview.rows[0].status, 'invalid');
  await assert.rejects(target.transfers.importBackup({ file: active, request_id: requestId(10) }), status(422));
  const inactive = file([account({ provider: 'source' })], [{ id: 'source', config, active: false }]);
  const result = await target.transfers.importBackup({ file: inactive, request_id: requestId(11), restore_enabled: true });
  assert.equal(target.store.account(result.account_ids[0])!.enabled, 0); assert.equal(target.providers.inactive.active, false);
  assert.equal(result.providers_imported, 0);
});

test('active custom configuration conflicts, builtin overrides and prototype provider IDs never mutate the registry', async t => {
  const target = fixture(t), config = custom(); target.provider('current', config);
  const before = Object.keys(target.providers), prototype = Object.getPrototypeOf(target.providers);
  const cases = [file([account({ provider: 'source' })], [{ id: 'source', config: { ...config, user_info_path: '/api/user/changed' }, active: true }]),
    file([account()], [{ id: 'anyrouter', config, active: true }]),
    ...['__proto__', 'constructor', 'prototype'].map(id => file([account({ provider: id })], [{ id, config, active: true }]))];
  for (const [index, backup] of cases.entries()) {
    const preview = await target.transfers.previewBackup({ file: backup }); assert.equal(preview.error_count, 1);
    await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(20 + index) }), status(422));
  }
  assert.deepEqual(Object.keys(target.providers), before); assert.equal(Object.getPrototypeOf(target.providers), prototype);
  assert.equal(target.store.accounts().length, 0); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
});

test('source providers sharing an origin cannot disagree on configuration or enabled state', async t => {
  const target = fixture(t), config = custom();
  for (const second of [{ ...config, user_info_path: '/api/user/other' }, config]) {
    const backup = file([account({ provider: 'a' }), account({ provider: 'b', credentials: { session: SESSION, api_user: '8' } })],
      [{ id: 'a', config, active: false }, { id: 'b', config: second, active: true }]);
    const preview = await target.transfers.previewBackup({ file: backup }); assert.equal(preview.error_count, 1); assert.equal(preview.can_import, false);
    await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(30) }), status(422));
  }
  assert.equal(target.store.accounts().length, 0); assert.equal(rowCount(target.store, 'custom_providers'), 0);
});

test('cookie sources and unsupported credential fields are strictly checked even for expired and duplicate rows', async t => {
  const target = fixture(t);
  const valid: CookieData = { name: 'fixture_session', value: OAUTH, domain: '.github.com', path: '/', secure: true, sameSite: 'None', expires: future() };
  const examples = [
    account({ credentials: { session: SESSION, api_user: '7', site_cookies: [{ ...valid, name: 'acw_tc', domain: 'evil.fixture.example' }] } }),
    account({ provider: 'agentrouter', credentials: { session: SESSION, api_user: '7', oauth_cookies: [valid] }, login_via: null }),
    account({ provider: 'agentrouter', credentials: { session: SESSION, api_user: '7', oauth_cookies: [{ ...valid, domain: '.linux.do', expires: 1 }] }, login_via: 'github' }),
    account({ provider: 'agentrouter', credentials: { session: SESSION, api_user: '7', oauth_cookies: [{ ...valid, partitionKey: 'secret' } as CookieData] }, login_via: 'github' }),
    account({ credentials: { session: SESSION, api_user: '7', refresh_token: REFRESH } }),
    { ...account(), credentials: { session: SESSION, api_user: '7', admin_password: SITE_PASSWORD } },
  ];
  for (const invalid of examples) {
    const preview = await target.transfers.previewBackup({ file: file([invalid]) }); assert.equal(preview.error_count, 1);
    for (const secret of [SESSION, OAUTH, REFRESH, SITE_PASSWORD]) assert.equal(JSON.stringify(preview).includes(secret), false);
  }
  const expired = account({ provider: 'agentrouter', credentials: { session: SESSION, api_user: '7', oauth_cookies: [{ ...valid, expires: 1 }] }, login_via: 'github' });
  const result = await target.transfers.importBackup({ file: file([expired]), request_id: requestId(31) });
  assert.equal(target.store.credentials(target.store.account(result.account_ids[0])!).oauth_cookies, undefined);
});

test('schemas, numeric IDs, counts and exported encrypted byte sizes enforce their independent bounds', async t => {
  const target = fixture(t);
  for (const bad of [{ ...file(), version: 2 }, { ...file(), version: '1' }, { ...file(), accounts: {} }, { ...file(), administrator: SESSION },
    { ...file(), exported_at: 'not-an-ISO-date' }, file([], [{ id: 'unused', config: custom(), active: true }])]) {
    await assert.rejects(target.transfers.previewBackup({ file: bad }), status(422));
  }
  for (const bad of [account({ enabled: 'true' as unknown as boolean }), account({ interval_hours: 169 }),
    account({ credentials: { session: SESSION, api_user: Number.MAX_SAFE_INTEGER + 1 as unknown as string } }),
    account({ credentials: { session: SESSION, api_user: '0' } }), { ...account(), status: 'success' }]) {
    assert.equal((await target.transfers.previewBackup({ file: file([bad]) })).error_count, 1);
  }
  const fiveHundred = file(Array.from({ length: 500 }, (_, index) => account({ name: '账号 ' + index, credentials: { session: SESSION, api_user: String(index + 1) } })));
  assert.equal((await target.transfers.previewBackup({ file: fiveHundred })).new_count, 500);
  await assert.rejects(target.transfers.previewBackup({ file: file([...fiveHundred.accounts, account()]) }), status(422));
  await assert.rejects(target.transfers.previewBackup({ file: { ...file(), extra: 'x'.repeat(MAX_ACCOUNT_TRANSFER_BYTES) } }), status(413));
  const source = fixture(t);
  for (let index = 0; index < 3; index++) source.add({ provider: 'agentrouter', api_user: String(index + 1), login_via: 'github',
    oauth_cookies: Array.from({ length: 80 }, (_, number) => ({ name: 'cookie_' + number, value: 'x'.repeat(32000), domain: '.github.com', path: '/', expires: future() })) });
  assert.ok(Buffer.byteLength(JSON.stringify(await source.transfers.exportBackup({ encrypted: false }))) < MAX_ACCOUNT_TRANSFER_BYTES);
  await assert.rejects(source.transfers.exportBackup({ password: BACKUP_PASSWORD }), status(413));
});

test('new accounts are paused by default and restoring enabled flags starts a fresh future schedule without saved balances', async t => {
  const target = fixture(t);
  const backup = file([account({ name: '启用账号' }), account({ name: '暂停账号', enabled: false, interval_hours: 12, credentials: { session: SESSION, api_user: '8' } })]);
  const result = await target.transfers.importBackup({ file: backup, request_id: requestId(32), restore_enabled: true });
  const enabled = target.store.account(result.account_ids[0])!, disabled = target.store.account(result.account_ids[1])!;
  assert.equal(enabled.enabled, 1); assert.ok(enabled.next_run && Date.parse(enabled.next_run) > Date.now());
  assert.equal(disabled.enabled, 0); assert.equal(disabled.next_run, null); assert.equal(disabled.interval_hours, 12);
  for (const row of [enabled, disabled]) { assert.equal(row.status, 'idle'); assert.equal(row.balance, null); assert.equal(row.last_run, null); }
  await assert.rejects(target.transfers.importBackup({ file: backup, request_id: requestId(33), restore_enabled: null }), status(422));
  assert.equal(target.store.runs().length, 0);
});

test('lost import replies replay after restart and the request ID is bound to exact file content and restore flags', async t => {
  const target = fixture(t), backup = file([account({ provider: 'source' })], [{ id: 'source', config: custom(), active: true }]);
  const body = { file: backup, request_id: requestId(34) };
  const first = await target.transfers.importBackup(body); target.restart();
  const repeated = await target.transfers.importBackup(body);
  assert.deepEqual(repeated, { ...first, replayed: true }); assert.equal(target.store.accounts().length, 1); assert.equal(rowCount(target.store, 'custom_providers'), 1);
  await assert.rejects(target.transfers.importBackup({ ...body, restore_enabled: true }), status(409));
  await assert.rejects(target.transfers.importBackup({ ...body, file: { ...backup, exported_at: '2026-11-11T01:00:00.000Z' } }), status(409));
  const log = target.store.db.prepare('SELECT * FROM account_file_imports').get()!;
  assert.equal(typeof log.fingerprint, 'string'); assert.equal(String(log.fingerprint).length, 64);
  for (const secret of [SESSION, SITE_PASSWORD, BACKUP_PASSWORD]) assert.equal(JSON.stringify(log).includes(secret), false);
});

test('concurrent identical import requests append once and duplicate-only imports never add a provider', async t => {
  const target = fixture(t), backup = file([account({ provider: 'source' })], [{ id: 'source', config: custom(), active: true }]);
  const results = await Promise.all([1, 2].map(() => target.transfers.importBackup({ file: backup, request_id: requestId(35) })));
  assert.equal(results[0].account_ids[0], results[1].account_ids[0]); assert.equal(target.store.accounts().length, 1); assert.equal(rowCount(target.store, 'custom_providers'), 1);
  const preview = await target.transfers.previewBackup({ file: backup }); assert.equal(preview.duplicate_count, 1); assert.equal(preview.can_import, false); assert.deepEqual(preview.providers_to_add, []);
  const skipped = await target.transfers.importBackup({ file: backup, request_id: requestId(36) }); assert.equal(skipped.imported, 0); assert.equal(skipped.skipped, 1); assert.equal(skipped.providers_imported, 0);
});

test('account and completion failures roll back new providers, all accounts and nonce records, then permit retry', async t => {
  const target = fixture(t), config = custom(), backup = file([account({ provider: 'source', name: 'First' }),
    account({ provider: 'source', name: 'Fail', credentials: { session: SESSION, api_user: '8' } })], [{ id: 'source', config, active: true }]);
  const before = Object.keys(target.providers), body = { file: backup, request_id: requestId(37) };
  for (const sql of ["CREATE TRIGGER abort_transfer BEFORE INSERT ON accounts WHEN NEW.name='Fail' BEGIN SELECT RAISE(ABORT,'fixture insertion failure'); END;",
    "CREATE TRIGGER abort_transfer BEFORE INSERT ON account_file_imports BEGIN SELECT RAISE(ABORT,'fixture completion failure'); END;"]) {
    target.store.db.exec(sql);
    await assert.rejects(target.transfers.importBackup(body));
    assert.equal(target.store.accounts().length, 0); assert.equal(rowCount(target.store, 'custom_providers'), 0); assert.equal(rowCount(target.store, 'account_file_imports'), 0);
    assert.deepEqual(Object.keys(target.providers), before); assert.equal(target.store.db.isTransaction, false);
    target.store.db.exec('DROP TRIGGER abort_transfer');
  }
  assert.equal((await target.transfers.importBackup(body)).imported, 2);
});

test('import binds a snapshot of the supplied file but evaluates the latest target provider configuration after async decode', async t => {
  const target = fixture(t), original = file(), untouched = structuredClone(original);
  const started = target.transfers.importBackup({ file: original, request_id: requestId(38) });
  original.accounts[0] = account({ name: 'Changed', credentials: { session: SESSION, api_user: '8' } });
  const result = await started; assert.equal(target.store.credentials(target.store.account(result.account_ids[0])!).api_user, '7');
  assert.equal((await target.transfers.importBackup({ file: untouched, request_id: requestId(38) })).replayed, true);
  await assert.rejects(target.transfers.importBackup({ file: original, request_id: requestId(38) }), status(409));
  const config = custom(); target.provider('current', config);
  const backup = file([account({ provider: 'source' })], [{ id: 'source', config, active: true }]);
  const pending = target.transfers.importBackup({ file: backup, request_id: requestId(39) });
  target.provider('current', { ...config, user_info_path: '/api/user/changed' });
  await assert.rejects(pending, status(422)); assert.equal(target.store.accounts().length, 1);
});

test('all transfer HTTP endpoints inherit administrator, CSRF, origin and no-store controls before parsing file contents', async t => {
  const f = await apiFixture(t);
  for (const [route, body] of [['/api/accounts/export', { encrypted: false }], ['/api/accounts/backup/preview', { file: file() }],
    ['/api/accounts/backup/import', { file: file(), request_id: requestId(40) }]] as const) {
    for (const [headers, expected] of [[{ cookie: '' }, 401], [{ 'x-csrf-token': '' }, 403], [{ origin: 'https://untrusted.fixture.example' }, 403],
      [{ 'content-type': 'text/plain' }, 403]] as const) {
      const response = await f.post(route, body, headers); assert.equal(response.status, expected); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  const unauthenticated = await fetch(f.origin + '/api/accounts/backup/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{invalid-json' });
  assert.equal(unauthenticated.status, 401); assert.equal(f.runtime.store.accounts().length, 0); assert.deepEqual(f.observed, []);
});

test('larger file parsing is isolated to backup endpoints and successful HTTP restore never contacts a site or starts tasks', async t => {
  const f = await apiFixture(t);
  const cookies = Array.from({ length: 20 }, (_, index) => ({ name: 'cookie_' + index, value: 'x'.repeat(32000), domain: '.github.com', path: '/', expires: future() }));
  const backup = file([account({ provider: 'agentrouter', login_via: 'github', credentials: { session: SESSION, api_user: '7', oauth_cookies: cookies } })]);
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) > 512 * 1024);
  const preview = await f.post('/api/accounts/backup/preview', { file: backup }); assert.equal(preview.status, 200); assert.equal(preview.data.error_count, 0);
  assert.equal((await f.post('/api/accounts/import', { file: backup })).status, 413);
  assert.equal((await f.post('/api/providers/probe', { file: backup })).status, 413);
  assert.equal((await f.post('/api/accounts/backup/preview', { file: { ...file(), extra: 'x'.repeat(MAX_ACCOUNT_TRANSFER_BYTES) } })).status, 413);
  const imported = await f.post('/api/accounts/backup/import', { file: backup, request_id: requestId(41), restore_enabled: true });
  assert.equal(imported.status, 200); assert.equal(imported.data.imported, 1); assert.equal(imported.headers.get('cache-control'), 'no-store');
  const row = f.runtime.store.account(imported.data.account_ids[0])!; assert.equal(row.enabled, 1); assert.equal(row.status, 'idle');
  assert.equal(f.runtime.scheduler.isBusy(row.id), false); assert.equal(f.runtime.store.runs().length, 0); assert.deepEqual(f.observed, []);
  const exported = await f.post('/api/accounts/export', { password: BACKUP_PASSWORD }); assert.equal(exported.status, 200);
  assert.equal(exported.data.format, ENCRYPTED_ACCOUNT_BACKUP_FORMAT); assert.equal(JSON.stringify(exported.data).includes(SESSION), false); assert.deepEqual(f.observed, []);
});

test('aborting an encrypted HTTP import during KDF prevents any late account, provider or nonce commit', async t => {
  const source = fixture(t), f = await apiFixture(t); source.add();
  const encrypted = await source.transfers.exportBackup({ password: BACKUP_PASSWORD });
  const entered = signal(), settled = signal(), original = f.runtime.accountTransfers.importBackup.bind(f.runtime.accountTransfers);
  f.runtime.accountTransfers.importBackup = async (value, authorize = () => {}) => {
    let first = true;
    try { return await original(value, () => { authorize(); if (first) { first = false; entered.notify(); } }); }
    finally { settled.notify(); }
  };
  const controller = new AbortController(), pending = f.post('/api/accounts/backup/import', { file: encrypted, password: BACKUP_PASSWORD, request_id: requestId(42) }, {}, controller.signal);
  await entered.promise; controller.abort(); await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError'); await settled.promise;
  assert.equal(f.runtime.store.accounts().length, 0); assert.equal(rowCount(f.runtime.store, 'custom_providers'), 0); assert.equal(rowCount(f.runtime.store, 'account_file_imports'), 0); assert.deepEqual(f.observed, []);
});

for (const revoked of ['logout', 'expired'] as const) test(`an administrator session ${revoked} during encrypted import is synchronously rechecked before commit`, async t => {
  const source = fixture(t), f = await apiFixture(t); source.add();
  const encrypted = await source.transfers.exportBackup({ password: BACKUP_PASSWORD });
  const entered = signal(), original = f.runtime.accountTransfers.importBackup.bind(f.runtime.accountTransfers);
  f.runtime.accountTransfers.importBackup = async (value, authorize = () => {}) => {
    let first = true;
    return original(value, () => { authorize(); if (first) { first = false; entered.notify(); } });
  };
  const pending = f.post('/api/accounts/backup/import', { file: encrypted, password: BACKUP_PASSWORD, request_id: requestId(43) });
  await entered.promise;
  if (revoked === 'logout') assert.equal((await f.post('/api/auth/logout', {})).status, 200);
  else f.runtime.store.db.prepare('UPDATE web_sessions SET expires_at=?').run(Date.now() / 1000 - 1);
  const response = await pending; assert.equal(response.status, 401); assert.equal(JSON.stringify(response.data).includes(SESSION), false);
  assert.equal(f.runtime.store.accounts().length, 0); assert.equal(rowCount(f.runtime.store, 'account_file_imports'), 0); assert.deepEqual(f.observed, []);
});

test('export rechecks an administrator owner change after KDF and releases no encrypted credential payload', async t => {
  const f = await apiFixture(t); f.runtime.store.addAccount({ name: '隔离密码', provider: 'agentrouter', auth_mode: 'password',
    email: LOGIN, password: SITE_PASSWORD, enabled: false, interval_hours: 6 });
  const entered = signal(), original = f.runtime.accountTransfers.exportBackup.bind(f.runtime.accountTransfers);
  f.runtime.accountTransfers.exportBackup = async (value, authorize = () => {}) => {
    let first = true;
    return original(value, () => { authorize(); if (first) { first = false; entered.notify(); } });
  };
  const pending = f.post('/api/accounts/export', { password: BACKUP_PASSWORD }); await entered.promise;
  f.runtime.store.db.prepare('UPDATE web_admin SET updated_at=updated_at+1 WHERE id=1').run();
  const response = await pending; assert.equal(response.status, 401); assert.equal(response.data.data, undefined);
  for (const secret of [LOGIN, SITE_PASSWORD, BACKUP_PASSWORD]) assert.equal(JSON.stringify(response.data).includes(secret), false);
  assert.deepEqual(f.observed, []);
});
