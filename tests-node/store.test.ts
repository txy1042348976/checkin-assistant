import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Fernet, FernetError, generateFernetKey } from '../server/fernet.js';
import { PROVIDERS } from '../server/providers.js';
import { Store, iso, roundMoney } from '../server/store.js';
import type { AccountInput, Credentials, ProviderInput } from '../server/types.js';

// Published Fernet specification vector. The migration envelope below contains
// the original application's spaced JSON, under the same verified key and IV.
const FERNET_KEY = 'cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=';
const FERNET_TOKEN = 'gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODy021cpGVWKZ_eEwCGM4BLLF_5CV9dOPmrhuVUPgJobwOz7JcbmrR64jVmpU4IwqDA==';
const LEGACY_ENVELOPE = 'gAAAAAAdwJ6wAAECAwQFBgcICQoLDA0ODymZlY8WyR2H7y33220k6cx-qMR55UjQ_WP6D24AHGOZjqDF8A7_0mXfkjxbcjqeJ64nDWsBN6weG-LCq5kn-T7zRhDpAnGnOw0AnI0J3_8gwrXjhfhBWMdCuBusMmsVoA==';
const VECTOR_TIME = Date.parse('1985-10-26T01:20:00-07:00') / 1000;
const VECTOR_IV = Buffer.from(Array.from({ length: 16 }, (_, index) => index));

function temporaryDirectory(t: test.TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t: test.TestContext, timezone = 'Asia/Shanghai') {
  const directory = temporaryDirectory(t), providers = structuredClone(PROVIDERS);
  const store = new Store({ dataDir: directory, providers, timezone });
  t.after(() => store.close());
  const add = (changes: Partial<AccountInput> = {}) => store.addAccount({
    name: 'fixture', provider: 'anyrouter', auth_mode: 'session', enabled: true,
    interval_hours: 6, session: 'fixture-private-session', api_user: '7', ...changes,
  });
  return { directory, providers, store, add };
}

function makeLegacyDatabase(directory: string): void {
  writeFileSync(path.join(directory, 'secret.key'), FERNET_KEY, { mode: 0o600 });
  const database = new DatabaseSync(path.join(directory, 'checkin-assistant.db'));
  database.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, provider TEXT NOT NULL,
      auth_mode TEXT NOT NULL, encrypted TEXT NOT NULL, enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'idle', last_run TEXT, next_run TEXT,
      last_message TEXT DEFAULT '等待首次签到', balance REAL, used_quota REAL,
      total_quota REAL, has_snapshot INTEGER DEFAULT 0, interval_hours INTEGER DEFAULT 6,
      created_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, account_name TEXT NOT NULL,
      provider TEXT NOT NULL, status TEXT NOT NULL, trigger_type TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, before_balance REAL, after_balance REAL,
      reward REAL, message TEXT, duration_ms INTEGER
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE custom_providers (id TEXT PRIMARY KEY, config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
  `);
  database.prepare(`INSERT INTO accounts(name,provider,auth_mode,encrypted,enabled,status,
    last_message,balance,used_quota,total_quota,has_snapshot,interval_hours,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('旧版账号', 'anyrouter', 'session', LEGACY_ENVELOPE, 0, 'vip_required', '旧版说明', 42, 8, 50, 1, 12, '2026-11-01T00:00:00+00:00');
  database.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,message) VALUES(?,?,?,?,?,?,?)')
    .run(1, '旧版账号', 'anyrouter', 'vip_required', 'manual', '2026-11-01T00:00:00+00:00', '旧版会员预览，未执行签到');
  database.prepare('INSERT INTO settings VALUES(?,?)').run('scheduler', '{"enabled": false, "interval_hours": 12}');
  database.close();
}

test('Fernet encrypts and verifies the official Python-compatible specification vector', () => {
  const cipher = new Fernet(FERNET_KEY);
  assert.equal(cipher.encrypt('hello', { timestamp: VECTOR_TIME, iv: VECTOR_IV }), FERNET_TOKEN);
  assert.equal(cipher.decrypt(FERNET_TOKEN, { ttl: 60, now: VECTOR_TIME + 1 }).toString(), 'hello');
  assert.deepEqual(JSON.parse(cipher.decrypt(LEGACY_ENVELOPE).toString()), { session: 'fixture-python-session', api_user: '7' });
  for (const plaintext of ['', '签到助手 🌤️', '\u0000binary\u0000', 'x'.repeat(1024)]) {
    assert.equal(cipher.decrypt(cipher.encrypt(plaintext)).toString(), plaintext);
  }
  assert.equal(Buffer.from(generateFernetKey(), 'base64url').length, 32);
});

test('Fernet authenticates before decrypting and enforces TTL and clock-skew boundaries', () => {
  const cipher = new Fernet(FERNET_KEY);
  const tampered = Buffer.from(FERNET_TOKEN, 'base64url'); tampered[30] ^= 1;
  for (const token of ['', 'invalid', FERNET_TOKEN + '!', tampered.toString('base64url')]) {
    assert.throws(() => cipher.decrypt(token), FernetError);
  }
  assert.throws(() => new Fernet(generateFernetKey()).decrypt(FERNET_TOKEN), FernetError);
  assert.throws(() => new Fernet('a'.repeat(32)), FernetError);
  assert.throws(() => cipher.encrypt('hello', { timestamp: -1 }), FernetError);
  assert.throws(() => cipher.encrypt('hello', { iv: Buffer.alloc(15) }), FernetError);
  assert.equal(cipher.decrypt(FERNET_TOKEN, { ttl: 60, now: VECTOR_TIME + 60 }).toString(), 'hello');
  assert.throws(() => cipher.decrypt(FERNET_TOKEN, { ttl: 60, now: VECTOR_TIME + 61 }), FernetError);
  assert.equal(cipher.decrypt(FERNET_TOKEN, { ttl: 60, now: VECTOR_TIME - 60 }).toString(), 'hello');
  assert.throws(() => cipher.decrypt(FERNET_TOKEN, { ttl: 60, now: VECTOR_TIME - 61 }), FernetError);
});

test('legacy SQLite database keeps account identity, Fernet secrets and scheduling preferences on migration and restart', t => {
  const directory = temporaryDirectory(t); makeLegacyDatabase(directory);
  const providers = structuredClone(PROVIDERS);
  const store = new Store({ dataDir: directory, providers, timezone: 'Asia/Shanghai' });
  t.after(() => store.close());
  const row = store.account(1)!;
  assert.equal(row.name, '旧版账号'); assert.equal(row.enabled, 0); assert.equal(row.interval_hours, 12);
  assert.equal(row.status, 'idle'); assert.equal(row.balance, 42); assert.equal(row.total_quota, 50);
  assert.equal(row.login_via, null);
  assert.deepEqual(store.credentials(row), { session: 'fixture-python-session', api_user: '7' });
  assert.deepEqual(store.settings(), { scheduler_enabled: false, interval_hours: 12 });
  assert.equal(store.runs()[0].currency, 'USD'); assert.equal(store.runs()[0].status, 'not_run');
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=1').get()!.status, 'vip_required');
  assert.match(String(store.db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM runs WHERE provider=? LIMIT 1').get('anyrouter')!.detail), /USING COVERING INDEX runs_provider/);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM runs INDEXED BY runs_started_at_jd WHERE julianday(started_at)>=julianday(?)')
    .get('2026-11-01T08:00:00+08:00')!.count, 1);
  assert.equal(readFileSync(store.keyPath, 'utf8'), FERNET_KEY);
  store.close();
  const restarted = new Store({ dataDir: directory, providers, timezone: 'Asia/Shanghai' });
  t.after(() => restarted.close());
  assert.equal(restarted.accounts().length, 1); assert.equal(restarted.credentials(restarted.account(1)!).session, 'fixture-python-session');
  assert.equal(restarted.addAccount({ name: 'new', provider: 'agentrouter', auth_mode: 'session', enabled: true, interval_hours: 6, session: 'new-private', api_user: '8' }), 2);
  assert.equal(restarted.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name IN ('runs_started_at_jd','runs_provider')").get()!.count, 2);
});

test('data files restrict permissions and an existing database never gets a replacement encryption key', t => {
  const f = fixture(t); f.add();
  if (process.platform !== 'win32') {
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    for (const file of [f.store.keyPath, f.store.dbPath, f.store.dbPath + '-wal', f.store.dbPath + '-shm']) {
      if (existsSync(file)) assert.equal(statSync(file).mode & 0o777, 0o600, file);
    }
  }
  f.store.close(); unlinkSync(f.store.keyPath);
  assert.throws(() => new Store({ dataDir: f.directory, providers: f.providers, timezone: 'UTC' }), /已有数据库缺少 secret.key/);
  assert.equal(existsSync(f.store.keyPath), false);
  writeFileSync(f.store.keyPath, generateFernetKey(), { mode: 0o600 });
  const wrongKeyStore = new Store({ dataDir: f.directory, providers: f.providers, timezone: 'UTC' });
  t.after(() => wrongKeyStore.close());
  assert.throws(() => wrongKeyStore.credentials(wrongKeyStore.account(1)!), error => error instanceof Error && /原 secret.key/.test(error.message) && !error.message.includes('fixture-private-session'));
  wrongKeyStore.close();
  if (process.platform !== 'win32') {
    chmodSync(f.store.keyPath, 0o644);
    assert.throws(() => new Store({ dataDir: f.directory, providers: f.providers, timezone: 'UTC' }), /密钥权限过宽/);
  }
});

test('public account responses omit all credentials including authentication embedded in a legacy proxy URL', t => {
  const f = fixture(t);
  const id = f.add({ proxy: { mode: 'custom', server: 'https://proxy.example:443', authenticate: true, username: 'proxy-user', password: 'proxy-private-password' } });
  const publicAccount = () => f.store.publicAccount(f.store.account(id)!);
  assert.deepEqual(publicAccount().proxy, { mode: 'custom', server: 'https://proxy.example:443', has_auth: true });
  assert.equal(publicAccount().enabled, true); assert.equal('encrypted' in publicAccount(), false);
  assert.equal('created_at' in publicAccount(), false); assert.equal('total_quota' in publicAccount(), false);
  let credentials: Credentials = f.store.credentials(f.store.account(id)!);
  credentials.proxy = { mode: 'custom', server: 'http://proxy-user:proxy-private-password@proxy.example:8080' };
  f.store.patch(id, { encrypted: f.store.encryptCredentials(credentials) });
  assert.deepEqual(publicAccount().proxy, { mode: 'custom', server: 'http://proxy.example:8080', has_auth: true });
  for (const server of ['http://proxy.example:8080/?password=proxy-private-password', 'proxy-private-password', 'http://proxy.example:8080/secret']) {
    credentials = { ...credentials, proxy: { mode: 'custom', server } };
    f.store.patch(id, { encrypted: f.store.encryptCredentials(credentials) });
    assert.equal(publicAccount().proxy.server, '');
  }
  f.store.patch(id, { encrypted: f.store.encryptCredentials({ ...credentials, proxy: { mode: 'direct', server: 'proxy-private-password' } }) });
  assert.deepEqual(publicAccount().proxy, { mode: 'direct', server: '', has_auth: false });
  const output = JSON.stringify(f.store.dashboard());
  for (const secret of ['fixture-private-session', 'proxy-user', 'proxy-private-password']) assert.equal(output.includes(secret), false);
  assert.equal(String(f.store.db.prepare('SELECT encrypted FROM accounts WHERE id=?').get(id)!.encrypted).includes('fixture-private-session'), false);
});

test('account edits preserve or replace authorization caches deliberately and guard active/provider changes', t => {
  const f = fixture(t), id = f.add({ enabled: false, login_via: 'github', oauth_cookies: [{ name: 'upstream', value: 'private-cache', domain: '.github.com', path: '/' }] });
  const input: AccountInput = { name: 'edited', provider: 'anyrouter', auth_mode: 'session', enabled: false, interval_hours: 12, replace_credentials: false };
  assert.equal(f.store.updateAccount(id, input), true);
  assert.equal(f.store.credentials(f.store.account(id)!).oauth_cookies![0].value, 'private-cache');
  assert.equal(f.store.account(id)!.login_via, 'github');
  assert.equal(f.store.updateAccount(id, { ...input, replace_credentials: true, session: 'replacement-session' }), true);
  assert.deepEqual(f.store.credentials(f.store.account(id)!), { session: 'replacement-session', api_user: '7' });
  for (const status of ['queued', 'running'] as const) {
    f.store.patch(id, { status });
    assert.throws(() => f.store.updateAccount(id, input), /任务运行中/); assert.equal(f.store.deleteAccount(id), false);
  }
  f.store.patch(id, { status: 'idle' });
  assert.throws(() => f.store.updateAccount(id, { ...input, provider: 'agentrouter' }), /不能更改平台/);
  assert.equal(f.store.updateAccount(id, { ...input, auth_mode: 'password', email: 'fixture@example.test', password: 'private-site-password' }), true);
  assert.deepEqual(f.store.credentials(f.store.account(id)!), { email: 'fixture@example.test', password: 'private-site-password' });
  assert.equal(f.store.account(id)!.login_via, null); assert.equal(f.store.account(id)!.enabled, 0);
  assert.equal(f.store.deleteAccount(id), true); assert.equal(f.store.updateAccount(id, input), false);
});

test('reauthorization checks identity and provider, keeps disabled settings and last known snapshot, and clears old cookies', t => {
  const f = fixture(t), id = f.add({ enabled: false, oauth_cookies: [{ name: 'upstream', value: 'old-private-cache', domain: '.github.com', path: '/' }],
    site_cookies: [{ name: 'waf', value: 'old-private-waf', domain: 'anyrouter.top', path: '/' }], refresh_token: 'old-private-refresh', oauth_user_agent: 'old agent' });
  f.store.patch(id, { balance: 42, used_quota: 8, total_quota: 50, has_snapshot: 1 });
  const args = { provider: 'anyrouter', session: 'new-private-session', api_user: '7', login_via: 'manual' };
  assert.throws(() => f.store.applyLogin(id, { ...args, api_user: '8' }), /身份与原账号不同/);
  assert.throws(() => f.store.applyLogin(id, { ...args, provider: 'agentrouter' }), /平台与原账号不一致/);
  for (const status of ['queued', 'running'] as const) {
    f.store.patch(id, { status }); assert.throws(() => f.store.applyLogin(id, args), /排队或运行/);
  }
  f.store.patch(id, { status: 'failed' });
  assert.equal(f.store.applyLogin(id, { ...args, balance: null }), true);
  const row = f.store.account(id)!;
  assert.equal(row.id, id); assert.equal(row.enabled, 0); assert.equal(row.status, 'idle');
  assert.equal(row.balance, 42); assert.equal(row.used_quota, 8); assert.equal(row.total_quota, 50); assert.equal(row.has_snapshot, 1);
  assert.deepEqual(f.store.credentials(row), { session: 'new-private-session', api_user: '7', oauth_cookies: [] });
  assert.equal(f.store.applyLogin(id, { ...args, balance: 0, used_quota: null, interval_hours: 24, name: '新'.repeat(50) }), true);
  assert.equal(f.store.account(id)!.balance, 0); assert.equal(f.store.account(id)!.used_quota, null); assert.equal(f.store.account(id)!.total_quota, null);
  assert.equal(Array.from(f.store.account(id)!.name).length, 40); assert.equal(f.store.account(id)!.interval_hours, 24);
  assert.equal(f.store.applyLogin(999, args), false);
});

test('outer transactions roll back account, snapshot and run writes even when nested helpers succeed', t => {
  const f = fixture(t), id = f.add();
  assert.throws(() => f.store.transaction(() => {
    f.add({ name: 'rolled-back' });
    f.store.applyLogin(id, { provider: 'anyrouter', session: 'rolled-back-session', api_user: '7', login_via: 'manual', balance: 12, used_quota: 3 });
    f.store.beginRun(f.store.account(id)!, 'manual');
    throw new Error('fixture completion failure');
  }), /fixture completion failure/);
  assert.equal(f.store.accounts().length, 1); assert.equal(f.store.runs().length, 0);
  assert.equal(f.store.credentials(f.store.account(id)!).session, 'fixture-private-session');
  assert.equal(f.store.account(id)!.balance, null); assert.equal(f.store.account(id)!.status, 'idle');
  assert.equal(f.store.db.isTransaction, false);
});

test('nested savepoints can roll back independently and transactions reject asynchronous callbacks', t => {
  const f = fixture(t), id = f.add();
  f.store.transaction(() => {
    f.store.patch(id, { name: 'outer change' });
    assert.throws(() => f.store.transaction(() => { f.store.patch(id, { name: 'inner change' }); f.add(); throw new Error('inner abort'); }), /inner abort/);
    assert.equal(f.store.account(id)!.name, 'outer change'); assert.equal(f.store.accounts().length, 1);
    f.store.patch(id, { enabled: 0 });
  });
  assert.equal(f.store.account(id)!.name, 'outer change'); assert.equal(f.store.account(id)!.enabled, 0);
  assert.throws(() => f.store.transaction(() => { f.store.patch(id, { name: 'async change' }); return Promise.resolve(); }), /不能跨越异步操作/);
  assert.equal(f.store.account(id)!.name, 'outer change');
});

test('run completion records real balances, keeps snapshots on failures, and rolls back a partially failed completion', t => {
  const f = fixture(t), id = f.add();
  f.store.patch(id, { balance: 42, used_quota: 8, total_quota: 50, has_snapshot: 1 });
  const failed = f.store.beginRun(f.store.account(id)!, 'scheduled');
  f.store.finishRun(failed, id, { status: 'failed', message: '原站未能确认', after_balance: null, reward: null }, 'scheduled');
  assert.equal(f.store.account(id)!.balance, 42); assert.equal(f.store.account(id)!.total_quota, 50);
  assert.equal(f.store.runs()[0].reward, null); assert.equal(f.store.runs()[0].trigger, 'scheduled');
  const successful = f.store.beginRun(f.store.account(id)!, 'manual');
  f.store.finishRun(successful, id, { status: 'synced', message: '仅同步', before_balance: 42, after_balance: 0, used_quota: 50, total_quota: 50, reward: null, duration_ms: 123 });
  assert.equal(f.store.account(id)!.balance, 0); assert.equal(f.store.runs()[0].after_balance, 0); assert.equal(f.store.runs()[0].duration_ms, 123);
  const atomic = f.store.beginRun(f.store.account(id)!, 'manual');
  f.store.db.exec("CREATE TRIGGER fixture_abort_snapshot BEFORE UPDATE ON accounts WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'fixture snapshot failure'); END;");
  assert.throws(() => f.store.finishRun(atomic, id, { status: 'success', message: '确认成功', reward: 3, after_balance: 3 }), /fixture snapshot failure/);
  assert.equal(f.store.runs()[0].status, 'running'); assert.equal(f.store.runs()[0].finished_at, null); assert.equal(f.store.account(id)!.balance, 0);
});

test('startup recovery distinguishes interrupted site work from work that never began', t => {
  const f = fixture(t), started = f.add({ name: 'started' }), queued = f.add({ name: 'queued' }), orphan = f.add({ name: 'orphan' });
  f.store.beginRun(f.store.account(started)!, 'scheduled');
  f.store.patch(queued, { status: 'queued' }); f.store.patch(orphan, { status: 'running' });
  assert.equal(f.store.recoverInterrupted(), 3);
  assert.equal(f.store.runs()[0].status, 'interrupted'); assert.equal(f.store.runs()[0].reward, null); assert.ok(f.store.runs()[0].finished_at);
  assert.equal(f.store.account(started)!.status, 'interrupted');
  for (const id of [queued, orphan]) assert.equal(f.store.account(id)!.status, 'idle');
  assert.equal(f.store.recoverInterrupted(), 0);
});

test('scheduler settings and custom provider configurations persist without replacing the shared registry', t => {
  const f = fixture(t), first = f.add(), second = f.add({ enabled: false, interval_hours: 24 });
  assert.equal(f.store.providers, f.providers);
  f.store.updateSettings(false, 12);
  assert.deepEqual(f.store.settings(), { scheduler_enabled: false, interval_hours: 12 });
  for (const id of [first, second]) assert.equal(f.store.account(id)!.interval_hours, 12);
  assert.throws(() => f.store.updateSettings(true, 0), /调度设置无效/);
  const config: ProviderInput = { name: '自定义', domain: 'https://fixture.example', template: 'newapi', login_path: '/login',
    sign_in_path: '/api/user/checkin', user_info_path: '/api/user/self', login_api_path: '/api/user/login', api_user_key: 'New-Api-User', quota_per_unit: 500000, currency: 'CNY' };
  f.store.saveProvider('custom', config, false);
  assert.deepEqual(f.store.providerConfigs(), [{ id: 'custom', config, active: false }]);
  f.store.saveProvider('custom', { ...config, name: '更新' }, { active: true });
  assert.equal(f.store.providerConfigs().length, 1); assert.equal(f.store.providerConfigs()[0].active, true);
  f.providers.anyrouter.currency = 'CNY'; assert.equal(f.store.publicAccount(f.store.account(first)!).currency, 'CNY');
});

test('dashboard distinguishes unknown and zero balances and never combines different currency or credit units', t => {
  const f = fixture(t); assert.equal(f.store.dashboard().stats.balance, null);
  const usd = f.add(), cny = f.add({ provider: 'agentrouter' });
  f.providers.agentrouter.currency = 'CNY';
  f.providers.creditA = { ...f.providers.anyrouter, currency: 'credits' };
  f.providers.creditB = { ...f.providers.anyrouter, currency: 'credits' };
  const creditA = f.add({ provider: 'creditA' }), creditB = f.add({ provider: 'creditB' });
  f.store.patch(usd, { balance: 0, has_snapshot: 1 }); f.store.patch(cny, { balance: 10, has_snapshot: 1 });
  f.store.patch(creditA, { balance: 1000, has_snapshot: 1 }); f.store.patch(creditB, { balance: 3, has_snapshot: 1 });
  for (const [id, reward] of [[usd, 1.25], [cny, 2.5], [creditA, 100], [creditB, 1]]) {
    const run = f.store.beginRun(f.store.account(id)!, 'manual');
    f.store.finishRun(run, id, { status: 'success', message: '已确认', reward });
  }
  const dashboard = f.store.dashboard();
  assert.equal(dashboard.stats.balance, 0); assert.equal(dashboard.stats.today_reward, 1.25); assert.equal(dashboard.stats.today_completed, 4);
  assert.deepEqual(dashboard.amounts.USD, { balance: 0, today_reward: 1.25 });
  assert.deepEqual(dashboard.amounts.CNY, { balance: 10, today_reward: 2.5 });
  assert.deepEqual(dashboard.amounts['credits:creditA'], { balance: 1000, today_reward: 100 });
  assert.deepEqual(dashboard.amounts['credits:creditB'], { balance: 3, today_reward: 1 });
  f.providers.anyrouter.currency = 'CNY';
  assert.equal(f.store.runs().find(run => run.account_id === usd)!.currency, 'USD');
});

test('seven-day calendar includes every run beyond the 100-row log window and groups UTC-midnight boundaries locally', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T16:15:00Z') });
  const f = fixture(t), first = f.add(), second = f.add({ api_user: '8' });
  const insert = f.store.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,reward,currency) VALUES(?,?,?,?,?,?,?,?)');
  f.store.transaction(() => {
    insert.run(first, 'fixture', 'anyrouter', 'success', 'scheduled', '2026-11-04T16:00:00+00:00', 3, 'USD');
    insert.run(first, 'fixture', 'anyrouter', 'success', 'scheduled', '2026-11-10T15:59:59+00:00', 2, 'USD');
    for (let index = 0; index < 120; index++) insert.run(index % 2 ? first : second, 'fixture', 'anyrouter', index % 3 ? 'success' : 'already_checked', 'scheduled', '2026-11-10T16:01:00+00:00', 1.25, 'USD');
  });
  const dashboard = f.store.dashboard();
  assert.equal(dashboard.runs.length, 100); assert.equal(dashboard.stats.today_reward, 150); assert.equal(dashboard.stats.today_completed, 2);
  assert.deepEqual(dashboard.trend.map(point => point.date), ['11-05', '11-06', '11-07', '11-08', '11-09', '11-10', '11-11']);
  assert.deepEqual(dashboard.trend[0], { date: '11-05', reward: 3, runs: 1 });
  assert.deepEqual(dashboard.trend[5], { date: '11-10', reward: 2, runs: 1 });
  assert.deepEqual(dashboard.trend[6], { date: '11-11', reward: 150, runs: 120 });
  assert.deepEqual(dashboard.trends.USD, dashboard.trend);
});

test('dashboard range scan excludes old history while keeping offset boundaries and the full recent calendar', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T16:15:00Z') });
  const f = fixture(t), id = f.add();
  const insert = f.store.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,reward,currency) VALUES(?,?,?,?,?,?,?,?)');
  f.store.transaction(() => {
    for (let index = 0; index < 20_000; index++) insert.run(id, 'old fixture', 'anyrouter', 'success', 'scheduled', '2025-11-10T16:01:00+00:00', 1000, 'EUR');
    insert.run(id, 'outside boundary', 'anyrouter', 'success', 'scheduled', '2026-11-03T00:14:59+08:00', 1000, 'EUR');
    insert.run(id, 'inclusive boundary', 'anyrouter', 'success', 'scheduled', '2026-11-03T00:15:00+08:00', 1000, 'CNY');
    for (let index = 0; index < 140; index++) insert.run(id, 'recent fixture', 'anyrouter', 'success', 'scheduled', '2026-11-11T00:01:00+08:00', 0.25, 'USD');
  });
  const statements: string[] = [], prepare = f.store.db.prepare.bind(f.store.db);
  t.mock.method(f.store.db, 'prepare', (sql: string) => { statements.push(sql); return prepare(sql); });
  const dashboard = f.store.dashboard();
  assert.deepEqual(dashboard.stats, { balance: null, today_reward: 35, today_completed: 1, total_accounts: 1 });
  assert.equal(dashboard.runs.length, 100);
  assert.deepEqual(dashboard.runs.map(run => run.id), Array.from({ length: 100 }, (_, index) => 20_142 - index));
  assert.deepEqual(dashboard.trend[6], { date: '11-11', reward: 35, runs: 140 });
  assert.equal(dashboard.trend.reduce((sum, point) => sum + point.runs, 0), 140);
  assert.deepEqual(Object.keys(dashboard.amounts), ['CNY', 'USD']);
  assert.deepEqual(dashboard.amounts.CNY, { balance: null, today_reward: 0 });
  assert.ok(dashboard.trends.CNY.every(point => point.reward === 0 && point.runs === 0));
  const rangeSql = statements.find(sql => sql.includes('julianday(started_at)'));
  assert.ok(rangeSql, 'dashboard must issue its bounded history query');
  const plan = prepare('EXPLAIN QUERY PLAN ' + rangeSql).all('2026-11-02T16:15:00+00:00').map(row => String(row.detail)).join('\n');
  assert.match(plan, /SEARCH runs USING INDEX runs_started_at_jd/);
  assert.doesNotMatch(plan, /SCAN runs/);
});

test('dashboard preserves descending insertion order when rounding cancellation-sensitive rewards', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T12:00:00Z') });
  const f = fixture(t, 'UTC'), id = f.add();
  const insert = f.store.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,reward,currency) VALUES(?,?,?,?,?,?,?,?)');
  insert.run(id, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-11T00:00:01Z', 1e16, 'USD');
  insert.run(id, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-11T00:00:02Z', -1e16, 'USD');
  insert.run(id, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-11T00:00:03Z', 1, 'USD');
  const dashboard = f.store.dashboard();
  assert.deepEqual(dashboard.runs.map(run => run.reward), [1, -1e16, 1e16]);
  assert.equal(dashboard.stats.today_reward, 0);
  assert.equal(dashboard.amounts.USD.today_reward, 0);
  assert.deepEqual(dashboard.trends.USD[6], { date: '11-11', reward: 0, runs: 3 });
  assert.deepEqual(dashboard.trend[6], { date: '11-11', reward: 0, runs: 3 });
});

test('calendar buckets match equal offset instants and keep credit units and deleted-account completion distinct', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-10T16:15:00Z') });
  const f = fixture(t), first = f.add(), removed = f.add({ provider: 'agentrouter' });
  f.providers.creditA = { ...f.providers.anyrouter, currency: 'credits' };
  f.providers.creditB = { ...f.providers.anyrouter, currency: 'credits' };
  const creditA = f.add({ provider: 'creditA' }), creditB = f.add({ provider: 'creditB' });
  assert.equal(f.store.deleteAccount(removed), true);
  const insert = f.store.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,reward,currency) VALUES(?,?,?,?,?,?,?,?)');
  insert.run(first, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-10T16:05:00+00:00', 1, 'USD');
  insert.run(first, 'fixture', 'anyrouter', 'already_checked', 'manual', '2026-11-11T00:05:00+08:00', 2, 'USD');
  insert.run(removed, 'deleted fixture', 'agentrouter', 'synced', 'manual', '2026-11-10T12:05:00-04:00', null, 'USD');
  insert.run(null, 'legacy fixture', 'anyrouter', 'success', 'manual', '2026-11-11T00:05:00+08:00', 3, 'USD');
  insert.run(first, 'fixture', 'anyrouter', 'failed', 'manual', '2026-11-10T23:59:59+08:00', 4, 'USD');
  insert.run(creditA, 'credit A', 'creditA', 'success', 'manual', '2026-11-11T00:05:00+08:00', 100, 'credits');
  insert.run(creditB, 'credit B', 'creditB', 'success', 'manual', '2026-11-11T00:05:00+08:00', 2, 'credits');
  const dashboard = f.store.dashboard();
  assert.equal(dashboard.stats.today_completed, 4);
  assert.equal(dashboard.stats.today_reward, 6);
  assert.equal(dashboard.stats.balance, null);
  assert.deepEqual(dashboard.trend[5], { date: '11-10', reward: 4, runs: 1 });
  assert.deepEqual(dashboard.trend[6], { date: '11-11', reward: 6, runs: 6 });
  assert.deepEqual(dashboard.trends.USD[6], { date: '11-11', reward: 6, runs: 4 });
  assert.deepEqual(dashboard.amounts['credits:creditA'], { balance: null, today_reward: 100 });
  assert.deepEqual(dashboard.amounts['credits:creditB'], { balance: null, today_reward: 2 });
});

test('timezone calendars remain seven distinct dates across a daylight-saving transition', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T07:30:00Z') });
  const f = fixture(t, 'America/Los_Angeles'), id = f.add();
  const insert = f.store.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,reward,currency) VALUES(?,?,?,?,?,?,?,?)');
  insert.run(id, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-01T01:30:00-07:00', 1, 'USD');
  insert.run(id, 'fixture', 'anyrouter', 'success', 'manual', '2026-11-01T01:30:00-08:00', 2, 'USD');
  const dashboard = f.store.dashboard();
  assert.deepEqual(dashboard.trend.map(point => point.date), ['10-26', '10-27', '10-28', '10-29', '10-30', '10-31', '11-01']);
  assert.deepEqual(dashboard.trend[6], { date: '11-01', reward: 3, runs: 2 });
  assert.equal(dashboard.stats.today_reward, 3);
});

test('money rounding preserves Python ties-to-even, negative zero and seconds-only UTC timestamps', () => {
  for (const [input, expected] of [[2.675, 2.67], [2.625, 2.62], [2.125, 2.12], [2.875, 2.88], [-2.675, -2.67], [-2.625, -2.62], [0.105, 0.1], [0.115, 0.12]]) {
    assert.equal(roundMoney(input), expected);
  }
  assert.ok(Object.is(roundMoney(-0.001), -0)); assert.equal(roundMoney(1e20), 1e20);
  assert.throws(() => roundMoney(Infinity), /额度数据格式无效/);
  assert.equal(iso(new Date('2026-11-10T11:12:13.999Z')), '2026-11-10T11:12:13+00:00');
});
