import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { HttpError } from '../server/errors.js';
import { UserBrowserImports, normalizeImportCookies, parseImportPayload, providerSignature, verifyImportProfile } from '../server/imports.js';
import { PROVIDERS } from '../server/providers.js';
import { WebSecurity } from '../server/security.js';
import { Store } from '../server/store.js';
import type { Profile } from '../server/types.js';

const SESSION = 'fixture-private-site-session';
const PROFILE: Profile = { id: 7, username: 'fixture', quota: 25_000_000, used_quota: 5_000_000 };
const payload = () => ({ session: SESSION, api_user: '7' });
const fail = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

async function fixture(t: test.TestContext, verifier: typeof verifyImportProfile = async () => PROFILE) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-import-'));
  const providers = structuredClone(PROVIDERS);
  const config = loadConfig({}, { dataDir: directory, adminPassword: 'Fixture-Secure-2026!', schedulerTickMs: 100_000, testMode: true });
  const store = new Store({ dataDir: directory, providers, timezone: config.timezone });
  const security = new WebSecurity(store, config, 'fixture-csrf'); await security.ready;
  const imports = new UserBrowserImports(store, providers, security, config, () => false, verifier);
  t.after(async () => { await imports.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const start = (provider = 'anyrouter', method: 'manual' | 'github' | 'linuxdo' = 'manual', account_id?: number) =>
    imports.start({ provider, method, name: '本地账号', interval_hours: 6, origin: 'http://127.0.0.1:8766', account_id });
  return { directory, config, providers, store, security, imports, start };
}

test('manual import verifies once then commits encrypted credentials, balance and single-use ticket together', async t => {
  let calls = 0;
  const f = await fixture(t, async (_provider, submitted) => { calls++; assert.equal(submitted.session, SESSION); return PROFILE; });
  const pending = f.start();
  assert.match(pending.id, /^[a-f0-9]{32}$/); assert.match(pending.connection!.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pending.browser_url, 'https://anyrouter.top/login');
  assert.equal(f.store.accounts().length, 0);
  const result = await f.imports.importCredentials(pending.id, payload());
  assert.equal(result.status, 'success'); assert.equal(calls, 1); assert.equal(result.connection, undefined);
  const row = f.store.account(result.account_id!)!;
  assert.equal(row.balance, 50); assert.equal(row.used_quota, 10); assert.equal(row.total_quota, 60);
  assert.equal(f.store.credentials(row).session, SESSION);
  assert.equal(f.store.runs().length, 0);
  assert.equal(JSON.stringify(f.store.dashboard()).includes(SESSION), false);
  assert.equal(String(f.store.db.prepare('SELECT encrypted_context FROM browser_imports WHERE id=?').get(pending.id)!.encrypted_context).includes(pending.connection!.ticket), false);
  assert.throws(() => f.imports.checkTicket(pending.id, pending.connection!.ticket), fail(410));
  assert.equal((await f.imports.importCredentials(pending.id, payload())).account_id, row.id);
  assert.equal(calls, 1);
});

test('agent Session-only import accurately supports balance sync without reward or OAuth cache', async t => {
  const f = await fixture(t), pending = f.start('agentrouter', 'github');
  const result = await f.imports.importCredentials(pending.id, payload(), pending.connection!.ticket);
  assert.match(result.message, /同步余额/); assert.match(result.message, /上游会话/);
  const credentials = f.store.credentials(f.store.account(result.account_id!)!);
  assert.equal(credentials.oauth_cookies?.length ?? 0, 0); assert.equal(f.store.runs().length, 0);
});

test('failed verification preserves pending connection and saves no account', async t => {
  const f = await fixture(t, async () => { throw new HttpError(422, '原站未能核验'); }), pending = f.start();
  await assert.rejects(f.imports.importCredentials(pending.id, payload()), fail(422));
  assert.equal(f.imports.view(pending.id)!.status, 'waiting'); assert.equal(f.store.accounts().length, 0);
  assert.equal(f.imports.checkTicket(pending.id, pending.connection!.ticket).connection, undefined);
});

test('different identity is rejected before replacement and preserves old account credentials', async t => {
  const f = await fixture(t);
  const id = f.store.addAccount({ name: 'original', provider: 'anyrouter', auth_mode: 'session', interval_hours: 6, enabled: false, session: 'original-secret', api_user: '7' });
  const pending = f.start('anyrouter', 'manual', id);
  await assert.rejects(f.imports.importCredentials(pending.id, { session: SESSION, api_user: '8' }), fail(422));
  assert.equal(f.store.credentials(f.store.account(id)!).session, 'original-secret');
  assert.equal(f.imports.view(pending.id)!.account_id, id);
});

test('same-account reauthorization replaces cache but preserves known balance if omitted by identity response', async t => {
  const f = await fixture(t, async () => ({ id: 7, username: 'fixture' }));
  const id = f.store.addAccount({ name: 'old', provider: 'agentrouter', auth_mode: 'session', enabled: false, interval_hours: 6,
    session: 'old-secret', api_user: '7', oauth_cookies: [{ name: 'upstream', value: 'old-cache', domain: '.github.com', path: '/' }] });
  f.store.patch(id, { balance: 42, used_quota: 8, total_quota: 50, has_snapshot: 1 });
  const pending = f.start('agentrouter', 'github', id), result = await f.imports.importCredentials(pending.id, payload());
  assert.equal(result.account_id, id); assert.equal(f.store.accounts().length, 1);
  const row = f.store.account(id)!;
  assert.equal(row.balance, 42); assert.equal(row.used_quota, 8);
  assert.deepEqual(f.store.credentials(row).oauth_cookies, []);
});

test('database completion failure rolls back both saved account and import completion', async t => {
  const f = await fixture(t), pending = f.start();
  f.store.db.exec("CREATE TRIGGER fixture_abort_completion BEFORE UPDATE ON browser_imports WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;");
  await assert.rejects(f.imports.importCredentials(pending.id, payload()), fail(422));
  assert.equal(f.store.accounts().length, 0); assert.equal(f.store.runs().length, 0);
  assert.equal(f.imports.view(pending.id)!.status, 'waiting');
});

test('cancel during verification aborts promptly and cannot save a later successful response', async t => {
  let complete!: (profile: Profile) => void;
  const f = await fixture(t, () => new Promise(resolve => { complete = resolve; })), pending = f.start();
  const promise = f.imports.importCredentials(pending.id, payload());
  assert.equal(f.imports.view(pending.id)!.status, 'verifying');
  await assert.rejects(f.imports.importCredentials(pending.id, payload()), fail(409));
  assert.equal(f.imports.cancel(pending.id), true);
  await assert.rejects(promise, fail(409));
  complete(PROFILE); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.view(pending.id)!.status, 'cancelled');
});

test('expired and changed-provider tickets terminate before any identity request', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return PROFILE; });
  const first = f.start();
  f.store.db.prepare('UPDATE browser_imports SET expires_at=? WHERE id=?').run(Date.now() / 1000 - 1, first.id);
  assert.throws(() => f.imports.checkTicket(first.id, first.connection!.ticket), fail(410));
  assert.equal(f.imports.view(first.id)!.status, 'expired');
  const second = f.start(); f.providers.anyrouter.user_info_path = '/api/user/changed';
  assert.throws(() => f.imports.checkTicket(second.id, second.connection!.ticket), fail(410));
  assert.equal(f.imports.view(second.id)!.status, 'cancelled'); assert.equal(calls, 0);
});

test('admin password setting changes revoke pending connection without exposing a ticket', async t => {
  const f = await fixture(t), pending = f.start();
  f.store.db.prepare('UPDATE web_admin SET updated_at=updated_at+1 WHERE id=1').run();
  assert.throws(() => f.imports.checkTicket(pending.id, pending.connection!.ticket), fail(410));
  assert.equal(f.imports.view(pending.id)!.status, 'cancelled');
});

test('provider cookie ordering does not change connection signature', () => {
  const first = structuredClone(PROVIDERS.anyrouter), second = structuredClone(first);
  second.waf_cookie_names.reverse(); assert.equal(providerSignature(first), providerSignature(second));
});

test('one pending connection and twenty verification attempts enforce bounded credentials probing', async t => {
  const f = await fixture(t, async () => { throw new HttpError(422, '未确认'); }), pending = f.start();
  assert.throws(() => f.start('agentrouter'), fail(409));
  f.store.db.prepare('UPDATE browser_imports SET attempts=20 WHERE id=?').run(pending.id);
  await assert.rejects(f.imports.importCredentials(pending.id, payload()), fail(429));
  assert.equal(f.store.accounts().length, 0);
});

test('optional OAuth cache is restricted to AgentRouter and selected upstream domain', async t => {
  const f = await fixture(t), pending = f.start('agentrouter', 'github');
  const cookie = { name: 'user_session', value: 'fixture-upstream', domain: '.linux.do', path: '/' };
  await assert.rejects(f.imports.importCredentials(pending.id, { ...payload(), oauth_cookies: [cookie] }), fail(422));
  const result = await f.imports.importCredentials(pending.id, { ...payload(), oauth_cookies: [{ ...cookie, domain: '.github.com' }] });
  assert.equal(f.store.credentials(f.store.account(result.account_id!)!).oauth_cookies![0].domain, '.github.com');
});

test('login credential parser rejects arbitrary fields, invalid header bytes and model API keys as IDs', () => {
  for (const body of [{ ...payload(), extra: 'secret' }, { ...payload(), session: 'unsafe;cookie' }, { ...payload(), session: 'line\r\nsecret' },
    { ...payload(), session: '雪' }, { ...payload(), api_user: 'sk-secret' }, { ...payload(), api_user: '0' },
    { ...payload(), oauth_user_agent: 'x\nCookie: secret' }, { ...payload(), oauth_cookies: Array(81).fill({}) }]) {
    assert.throws(() => parseImportPayload(body), fail(422));
  }
  assert.equal(parseImportPayload({ ...payload(), api_user: '0007' }).api_user, '7');
});

test('cookie normalization preserves replay attributes and rejects mismatches, duplicates and partitions', () => {
  const valid = { name: 'acw_tc', value: 'fixture-waf', domain: 'anyrouter.top', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' as const, expires: -1 };
  assert.deepEqual(normalizeImportCookies([valid], { host: 'anyrouter.top', names: new Set(['acw_tc']) }), [valid]);
  assert.deepEqual(normalizeImportCookies([{ ...valid, expires: 1 }]), []);
  for (const cookies of [[{ ...valid, domain: 'other.example' }], [{ ...valid, name: 'session' }], [valid, valid], [{ ...valid, partitionKey: {} }],
    [{ ...valid, partitioned: true }], [{ ...valid, _crHasCrossSiteAncestor: false }], [{ ...valid, sameSite: 'None' as const, secure: false }],
    [{ ...valid, sameSite: 'None' as const, secure: undefined }]]) {
    assert.throws(() => normalizeImportCookies(cookies, { host: 'anyrouter.top', names: new Set(['acw_tc']) }), fail(422));
  }
});

test('real HTTP import verifier makes one target-site GET and never transmits optional upstream cookies', async t => {
  const observed: { method: string; url: string; cookie: string; user: string }[] = [];
  const server = createServer((req, res) => {
    observed.push({ method: req.method!, url: req.url!, cookie: req.headers.cookie || '', user: String(req.headers['new-api-user']) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data: PROFILE }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const provider = { ...PROVIDERS.anyrouter, domain: `http://127.0.0.1:${address.port}` };
  const data = parseImportPayload({ ...payload(), oauth_cookies: [{ name: 'upstream', value: 'never-forward', domain: '.github.com', path: '/' }] });
  const profile = await verifyImportProfile(provider, data, { mode: 'direct' }, loadConfig({}));
  assert.equal(profile.id, 7); assert.equal(observed.length, 1); assert.equal(observed[0].method, 'GET');
  assert.match(observed[0].url, /^\/api\/user\/self\?_checkin_assistant_verify=/); assert.equal(observed[0].cookie, 'session=' + SESSION);
  assert.equal(observed[0].user, '7'); assert.equal(JSON.stringify(observed).includes('never-forward'), false);
});

test('import verification honors Cookie path boundaries, expiry and Secure and orders valid scopes by path length', async t => {
  const observed: string[] = [];
  const server = createServer((req, res) => {
    observed.push(req.headers.cookie || '');
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true, data: PROFILE }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const provider = { ...PROVIDERS.anyrouter, domain: `http://127.0.0.1:${address.port}` };
  const cookie = { name: 'acw_tc', value: 'root', domain: '127.0.0.1', path: '/', expires: -1 };
  const data = parseImportPayload({ ...payload(), site_cookies: [cookie, { ...cookie, path: '/api/u', value: 'prefix-wrong' },
    { ...cookie, path: '/api/user', value: 'scoped' }, { ...cookie, path: '/api/user/self', value: 'exact' },
    { ...cookie, name: 'expired', expires: 1 }, { ...cookie, name: 'secure-only', secure: true }] });
  await verifyImportProfile(provider, data, { mode: 'direct' }, loadConfig({}));
  assert.deepEqual(observed, ['acw_tc=exact; acw_tc=scoped; acw_tc=root; session=' + SESSION]);
});

test('direct manual save shares an in-flight verification and safely replays a lost successful response', async t => {
  let finish!: (profile: Profile) => void, calls = 0;
  const f = await fixture(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填账号', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const request = 'a'.repeat(32);
  const first = f.imports.importManual(input, payload(), request), second = f.imports.importManual(input, payload(), request);
  assert.equal(first, second); assert.equal(calls, 1);
  assert.equal(f.imports.current()!.id, request); assert.equal(f.imports.current(false), null);
  finish(PROFILE);
  const [saved, shared] = await Promise.all([first, second]);
  assert.equal(saved.account_id, shared.account_id);
  const replayed = await f.imports.importManual(input, payload(), request);
  assert.equal(replayed.account_id, saved.account_id); assert.equal(calls, 1);
  assert.equal(f.store.accounts().length, 1); assert.equal(f.store.runs().length, 0);
  await assert.rejects(f.imports.importManual({ ...input, name: '变更账号' }, payload(), request), fail(409));
  await assert.rejects(f.imports.importManual(input, { ...payload(), session: 'changed-session' }, request), fail(409));
  assert.equal(JSON.stringify(saved).includes(SESSION), false);
  assert.equal(String(f.store.db.prepare('SELECT encrypted_context FROM browser_imports WHERE id=?').get(request)!.encrypted_context).includes(SESSION), false);
});

test('direct manual failure releases the form and permits an unchanged retry or a corrected new request', async t => {
  let rejectNext = true, calls = 0;
  const f = await fixture(t, async () => { calls++; if (rejectNext) throw new HttpError(422, '原站校验失败'); return PROFILE; });
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填账号', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const request = 'b'.repeat(32);
  await assert.rejects(f.imports.importManual(input, payload(), request), fail(422));
  assert.equal(f.imports.view(request)!.status, 'failed'); assert.equal(f.imports.current(), null);
  assert.equal(f.store.accounts().length, 0);
  rejectNext = false;
  const saved = await f.imports.importManual(input, payload(), request);
  assert.equal(saved.status, 'success'); assert.equal(calls, 2); assert.equal(f.store.accounts().length, 1);
  rejectNext = true;
  await assert.rejects(f.imports.importManual(input, payload(), 'c'.repeat(32)), fail(422));
  rejectNext = false;
  const corrected = await f.imports.importManual({ ...input, name: '修正账号' }, payload(), 'd'.repeat(32));
  assert.equal(corrected.status, 'success'); assert.equal(f.store.accounts().length, 2);
});

test('direct manual reconnection preserves disabled state and proxy while refusing a different account identity', async t => {
  const proxy = { mode: 'custom' as const, server: 'http://proxy.example:8080', authenticate: true, username: 'private-proxy-user', password: 'private-proxy-password' };
  let calls = 0;
  const f = await fixture(t, async (_provider, _payload, submittedProxy) => { calls++; assert.deepEqual(submittedProxy, proxy); return PROFILE; });
  const id = f.store.addAccount({ name: '旧账号', provider: 'agentrouter', auth_mode: 'session', interval_hours: 12, enabled: false,
    session: 'old-private-session', api_user: '7', proxy, oauth_cookies: [{ name: 'upstream', value: 'old-private-cache', domain: '.github.com', path: '/' }] });
  const input = { provider: 'agentrouter', method: 'manual' as const, name: '手填重连', interval_hours: 24, origin: 'http://127.0.0.1:8766', account_id: id };
  await assert.rejects(f.imports.importManual(input, { ...payload(), api_user: '8' }, 'e'.repeat(32)), fail(422));
  assert.equal(calls, 0); assert.equal(f.imports.current(), null);
  assert.equal(f.store.credentials(f.store.account(id)!).session, 'old-private-session');
  const saved = await f.imports.importManual(input, payload(), 'f'.repeat(32));
  assert.equal(saved.account_id, id); assert.match(saved.message, /仅同步余额/);
  const row = f.store.account(id)!;
  assert.equal(row.enabled, 0); assert.equal(row.interval_hours, 24); assert.equal(row.name, '手填重连');
  assert.equal(row.login_via, 'manual'); assert.equal(f.store.accounts().length, 1); assert.equal(f.store.runs().length, 0);
  assert.deepEqual(f.store.credentials(row).proxy, proxy); assert.deepEqual(f.store.credentials(row).oauth_cookies, []);
});

test('direct manual cancellation remains final and cannot save a late successful identity reply', async t => {
  let finish!: (profile: Profile) => void;
  const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填取消', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const request = '1'.repeat(32), saving = f.imports.importManual(input, payload(), request);
  assert.equal(f.imports.cancel(request), true);
  await assert.rejects(saving, fail(409));
  finish(PROFILE); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.imports.importManual(input, payload(), request), fail(409));
  assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null);
});

test('direct manual failed retries remain bounded by expiry, attempts and administrator identity', async t => {
  const f = await fixture(t, async () => { throw new HttpError(422, '原站暂不可用'); });
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填重试', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const expired = '2'.repeat(32), limited = '3'.repeat(32), changedAdmin = '4'.repeat(32);
  await assert.rejects(f.imports.importManual(input, payload(), expired), fail(422));
  f.store.db.prepare('UPDATE browser_imports SET expires_at=? WHERE id=?').run(Date.now() / 1000 - 1, expired);
  await assert.rejects(f.imports.importManual(input, payload(), expired), fail(410));
  await assert.rejects(f.imports.importManual(input, payload(), limited), fail(422));
  f.store.db.prepare('UPDATE browser_imports SET attempts=20 WHERE id=?').run(limited);
  await assert.rejects(f.imports.importManual(input, payload(), limited), fail(429));
  assert.equal(f.imports.current(), null);
  await assert.rejects(f.imports.importManual(input, payload(), changedAdmin), fail(422));
  f.store.db.prepare('UPDATE web_admin SET updated_at=updated_at+1 WHERE id=1').run();
  await assert.rejects(f.imports.importManual(input, payload(), changedAdmin), fail(409));
  assert.equal(f.store.accounts().length, 0);
});

test('restart releases an interrupted direct save so a refreshed form or the original nonce can proceed', async t => {
  const f = await fixture(t, async () => { throw new HttpError(422, '合成中断'); });
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '重启后手填', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const request = '5'.repeat(32);
  await assert.rejects(f.imports.importManual(input, payload(), request), fail(422));
  await f.imports.close();
  f.store.db.prepare("UPDATE browser_imports SET status='verifying' WHERE id=?").run(request);
  const restored = new UserBrowserImports(f.store, f.providers, f.security, f.config, () => false, async () => PROFILE);
  try {
    assert.equal(restored.current(), null); assert.equal(restored.current(false), null);
    assert.equal(restored.view(request)!.status, 'failed');
    const refreshed = await restored.importManual(input, payload(), '6'.repeat(32));
    assert.equal(refreshed.status, 'success');
    const retried = await restored.importManual(input, payload(), request);
    assert.equal(retried.status, 'success'); assert.equal(f.store.accounts().length, 2);
  } finally { await restored.close(); }
});

for (const mutation of ['provider', 'administrator', 'busy', 'deleted'] as const) test(`direct save refuses a late identity reply after ${mutation} changes`, async t => {
  let finish!: (profile: Profile) => void;
  const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const id = f.store.addAccount({ name: '保留原账号', provider: 'anyrouter', auth_mode: 'session', interval_hours: 6, enabled: false,
    session: 'original-private-session', api_user: '7' });
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填更新', interval_hours: 12,
    origin: 'http://127.0.0.1:8766', account_id: id };
  const request = '7'.repeat(32), saving = f.imports.importManual(input, payload(), request);
  if (mutation === 'provider') f.providers.anyrouter.user_info_path = '/changed-profile';
  else if (mutation === 'administrator') f.store.db.prepare('UPDATE web_admin SET updated_at=updated_at+1 WHERE id=1').run();
  else if (mutation === 'busy') f.store.patch(id, { status: 'queued' });
  else assert.equal(f.store.deleteAccount(id), true);
  finish(PROFILE);
  await assert.rejects(saving, fail(409));
  assert.equal(f.imports.current(), null); assert.equal(f.store.runs().length, 0);
  if (mutation === 'deleted') assert.equal(f.store.accounts().length, 0);
  else {
    const original = f.store.account(id)!;
    assert.equal(original.name, '保留原账号'); assert.equal(original.interval_hours, 6);
    assert.equal(f.store.credentials(original).session, 'original-private-session');
  }
});

test('direct save rolls back an interrupted transaction and releases the queue for the same nonce retry', async t => {
  const f = await fixture(t);
  const input = { provider: 'anyrouter', method: 'manual' as const, name: '手填原子保存', interval_hours: 6, origin: 'http://127.0.0.1:8766' };
  const request = '8'.repeat(32);
  f.store.db.exec("CREATE TRIGGER fixture_manual_abort BEFORE UPDATE ON browser_imports WHEN NEW.status='success' BEGIN SELECT RAISE(ABORT,'fixture interrupted commit'); END;");
  await assert.rejects(f.imports.importManual(input, payload(), request), fail(422));
  assert.equal(f.store.accounts().length, 0); assert.equal(f.imports.current(), null);
  assert.equal(f.imports.view(request)!.status, 'failed');
  f.store.db.exec('DROP TRIGGER fixture_manual_abort');
  const saved = await f.imports.importManual(input, payload(), request);
  assert.equal(saved.status, 'success'); assert.equal(f.store.accounts().length, 1);
  assert.equal(f.store.credentials(f.store.account(saved.account_id!)!).session, SESSION);
});
