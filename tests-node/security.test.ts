import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { HttpError, isRecord } from '../server/errors.js';
import { PROVIDERS } from '../server/providers.js';
import { AUTH_BODY_LIMIT, PASSWORD_ITERATIONS, WebSecurity, hashPassword, verifyPassword, type SecurityConfig } from '../server/security.js';
import { Store } from '../server/store.js';

const PASSWORD = 'Fixture-Administrator-2026!';
// Fixed PBKDF2/SHA-256 fixture in the original Python application's encoding.
const PASSWORD_HASH = 'pbkdf2_sha256$600000$00112233445566778899aabbccddeeff$58008c6c20b9a0e2b74cf79061b0015ffead6c30fa0ed41448b2ee76a225ebda';
const LEGACY_TOKEN = 'fixture-legacy-session-token-0123456789_ABCDEFG';
const LEGACY_TOKEN_HASH = 'cf997f5b690c958b97d36fee3cfb3fec28dd39c9ef38b7e3ed8cd665c56e1120';
const LEGACY_FINGERPRINT = 'b6a6a38f99111683dda6649c2c54b32b8ef1d9900b6b32389abb3a6e7867096b';
const CSRF = 'fixture-csrf-token-for-tests';
const fail = (status: number) => (error: unknown) => error instanceof HttpError && error.status === status;

interface FixtureOptions {
  configured?: boolean;
  config?: Partial<SecurityConfig>;
  Security?: typeof WebSecurity;
}

function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-security-'));
  const providers = structuredClone(PROVIDERS), store = new Store({ dataDir: directory, providers, timezone: 'Asia/Shanghai' });
  store.db.exec(`
    CREATE TABLE web_admin (
      id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
    );
    CREATE TABLE web_sessions (
      token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES web_admin(id) ON DELETE CASCADE,
      created_at REAL NOT NULL, expires_at REAL NOT NULL
    );
  `);
  if (options.configured !== false) {
    store.db.prepare('INSERT INTO web_admin VALUES(1,?,?,?,?)').run('owner', PASSWORD_HASH, 1735689600, 1735689600);
    store.db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(LEGACY_TOKEN_HASH, 1, Date.now() / 1000, Date.now() / 1000 + 3600);
  }
  const config: SecurityConfig = { enabled: true, publicUrl: '', sessionHours: 24, loginMaxAttempts: 8,
    loginWindowSeconds: 600, loginGlobalMaxAttempts: 60, adminUser: 'owner', ...options.config };
  const context = { directory, providers, store, config, security: undefined as unknown as WebSecurity,
    stores: [store], server: undefined as Server | undefined, parserCalls: 0, base: '' };
  t.after(async () => {
    try {
      if (context.server?.listening) await new Promise<void>((resolve, reject) => context.server!.close(error => error ? reject(error) : resolve()));
    } finally {
      for (const resource of context.stores) resource.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const Security = options.Security ?? WebSecurity;
  context.security = new Security(store, config, CSRF);
  return context;
}

async function httpFixture(t: test.TestContext, options: FixtureOptions = {}) {
  const f = fixture(t, options); await f.security.ready;
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
  // Match production's ordering: reject untrusted or unauthenticated requests
  // before JSON parsing, and cap chunked authentication requests in verify().
  app.use(f.security.guard);
  app.use(express.json({ limit: 65536, strict: true, verify(req, _res, body) {
    f.parserCalls++;
    if ((req as Request).path.toLowerCase().startsWith('/api/auth/') && body.length > AUTH_BODY_LIMIT) throw new HttpError(413, '登录请求内容过长。');
  } }));
  f.security.installRoutes(app);
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/private', (_req, res) => res.json({ username: res.locals.webUser }));
  app.post('/api/private', (_req, res) => res.json({ username: res.locals.webUser }));
  app.get('/browser/fixture', (_req, res) => res.json({ username: res.locals.webUser }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (error instanceof HttpError) {
      for (const [key, value] of Object.entries(error.headers ?? {})) res.set(key, value);
      res.status(error.status).json({ detail: error.message });
    } else if (isRecord(error) && error.type === 'entity.too.large') res.status(413).json({ detail: '请求内容过长。' });
    else if (error instanceof SyntaxError || (isRecord(error) && error.type === 'entity.parse.failed')) res.status(400).json({ detail: '请求内容格式无效。' });
    else res.status(500).json({ detail: '请求未完成，请稍后重试。' });
  });
  f.server = createServer(app);
  await new Promise<void>(resolve => f.server!.listen(0, '127.0.0.1', resolve));
  const address = f.server.address(); assert.ok(address && typeof address !== 'string');
  f.base = `http://127.0.0.1:${address.port}`;
  const call = (apiPath: string, options: { method?: string; body?: unknown; raw?: string; cookie?: string;
    csrf?: string; origin?: string | null; headers?: Record<string, string> } = {}) => {
    const method = options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.origin !== null) headers.Origin = options.origin ?? (f.config.publicUrl || f.base);
    if (!['GET', 'HEAD'].includes(method)) headers['Content-Type'] = 'application/json';
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.csrf) headers['X-CSRF-Token'] = options.csrf;
    Object.assign(headers, options.headers);
    return fetch(f.base + apiPath, { method, headers, body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)) });
  };
  return { ...f, call, context: f };
}

function sessionCookie(response: globalThis.Response): { cookie: string; token: string; attributes: string } {
  const attributes = response.headers.get('set-cookie'); assert.ok(attributes);
  const cookie = attributes.split(';')[0];
  return { cookie, token: cookie.slice(cookie.indexOf('=') + 1), attributes };
}

async function chunkedPost(base: string, apiPath: string, body: string, origin: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(base + apiPath, { method: 'POST', headers: {
      'Content-Type': 'application/json', Origin: origin, 'Transfer-Encoding': 'chunked',
    } }, response => {
      let content = ''; response.setEncoding('utf8'); response.on('data', value => { content += value; });
      response.on('end', () => resolve({ status: response.statusCode!, body: content })); response.on('error', reject);
    });
    request.on('error', reject);
    const midpoint = Math.floor(body.length / 2); request.write(body.slice(0, midpoint)); request.end(body.slice(midpoint));
  });
}

interface PendingVerification { password: string; encoded: string; resolve(value: boolean): void; reject(error: Error): void }
class GatedSecurity extends WebSecurity {
  readonly pending: PendingVerification[] = [];
  protected override verifyHash(password: string, encoded: string): Promise<boolean> {
    return new Promise((resolve, reject) => this.pending.push({ password, encoded, resolve, reject }));
  }
}

async function pendingCount(security: GatedSecurity, count: number): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (security.pending.length >= count) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('Fixture verification did not start');
}

test('PBKDF2 accepts the static Python administrator hash and rejects malformed or excessive work factors', async () => {
  assert.equal(PASSWORD_ITERATIONS, 600000);
  assert.equal(await verifyPassword(PASSWORD, PASSWORD_HASH), true);
  assert.equal(await verifyPassword('incorrect-password', PASSWORD_HASH), false);
  const hash = await hashPassword('Unicode-签到-2026!');
  assert.match(hash, /^pbkdf2_sha256\$600000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.equal(await verifyPassword('Unicode-签到-2026!', hash), true);
  for (const encoded of [null, '', 'other$600000$' + 'a'.repeat(32) + '$' + 'b'.repeat(64),
    PASSWORD_HASH.replace('$600000$', '$99999$'), PASSWORD_HASH.replace('$600000$', '$2000001$'),
    PASSWORD_HASH.replace('00112233445566778899aabbccddeeff', 'z'.repeat(32)), PASSWORD_HASH + '$extra']) {
    assert.equal(await verifyPassword(PASSWORD, encoded), false);
  }
  assert.equal(await verifyPassword('x'.repeat(1025), PASSWORD_HASH), false);
  assert.equal(await verifyPassword('\ud800', PASSWORD_HASH), false);
  await assert.rejects(hashPassword('\ud800'), /密码格式无效/);
});

test('legacy administrator, active session digests and Python owner fingerprints remain valid after a Node restart', async t => {
  const f = fixture(t, { config: { adminUser: 'replacement-user', adminPassword: 'weak' } });
  await f.security.ready;
  assert.equal(f.security.configured, true); assert.equal(f.security.userForToken(LEGACY_TOKEN), 'owner');
  assert.equal(f.security.adminFingerprint(), LEGACY_FINGERPRINT);
  const session = await f.security.login('peer', 'owner', PASSWORD);
  assert.equal(session.username, 'owner'); assert.equal(f.security.userForToken(session.token), 'owner');
  f.store.close();
  const reopened = new Store({ dataDir: f.directory, providers: f.providers, timezone: 'Asia/Shanghai' }); f.stores.push(reopened);
  const security = new WebSecurity(reopened, { ...f.config, adminUser: 'ignored', adminPassword: 'another-weak-password' }, CSRF);
  await security.ready;
  assert.equal(security.userForToken(session.token), 'owner'); assert.equal(security.userForToken(LEGACY_TOKEN), 'owner');
  assert.equal(security.adminFingerprint(), LEGACY_FINGERPRINT);
  assert.equal(reopened.db.prepare('SELECT password_hash FROM web_admin').get()!.password_hash, PASSWORD_HASH);
  const saved = JSON.stringify(reopened.db.prepare('SELECT * FROM web_sessions').all());
  assert.equal(saved.includes(session.token), false); assert.equal(saved.includes(LEGACY_TOKEN), false);
});

test('origins compare exact normalized protocol, hostname and port while rejecting credentials and normalized-away paths', t => {
  const f = fixture(t);
  for (const [origin, host] of [['http://EXAMPLE.com:80/', 'example.com'], ['https://example.com.', 'https://example.com:443'],
    ['http://[::1]:8765', '[::1]:8765'], ['https://例子.测试', 'https://xn--fsqu00a.xn--0zwm56d']]) {
    assert.equal(f.security.originAllowed(origin, host), true, origin);
  }
  for (const origin of [null, undefined, 'null', '', 'https://user:private@example.com', 'https://example.com/path',
    'https://example.com/../', 'https://example.com/?secret=value', 'https://example.com/#hash',
    'https://example.com:0', 'https://example.com:65536', 'https://example.com:bad', 'https://example.com\\evil',
    'https://example.com\n', 'https://example.com.evil', 'http://example.com', 'https://example.com:444', 'https://...']) {
    assert.equal(f.security.originAllowed(origin, 'https://example.com'), false, String(origin));
  }
  const publicSecurity = new WebSecurity(f.store, { ...f.config, publicUrl: 'https://panel.example' }, CSRF);
  assert.equal(publicSecurity.originAllowed('https://panel.example:443', '127.0.0.1:8765'), true);
  assert.equal(publicSecurity.originAllowed('http://127.0.0.1:8765', '127.0.0.1:8765'), false);
  assert.throws(() => new WebSecurity(f.store, { ...f.config, publicUrl: 'https://panel.example/../' }, CSRF), /完整的 HTTP/);
});

test('HTTP login/status/logout use HttpOnly SameSite cookies and protect data and mutations before parsing', async t => {
  const f = await httpFixture(t);
  let response = await f.call('/api/auth/status'), body = await response.json();
  assert.equal(body.configured, true); assert.equal(body.authenticated, false); assert.equal(body.username, null);
  assert.equal('csrf_token' in body, false); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await f.call('/api/health')).status, 200);
  const baseline = f.context.parserCalls;
  assert.equal((await f.call('/api/private', { raw: '{invalid' })).status, 401);
  assert.equal(f.context.parserCalls, baseline);
  assert.equal((await f.call('/browser/fixture')).status, 401);
  response = await f.call('/api/auth/login', { body: { username: 'owner', password: PASSWORD } });
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(body, { authenticated: true, username: 'owner', csrf_token: CSRF });
  const session = sessionCookie(response);
  assert.match(session.attributes, /HttpOnly/); assert.match(session.attributes, /SameSite=Strict/);
  assert.match(session.attributes, /Path=\//); assert.match(session.attributes, /Max-Age=86400/); assert.doesNotMatch(session.attributes, /; Secure/);
  const saved = f.store.db.prepare('SELECT token_hash FROM web_sessions WHERE token_hash=?').get(createHash('sha256').update(session.token).digest('hex'));
  assert.ok(saved); assert.equal(JSON.stringify(saved).includes(session.token), false);
  response = await f.call('/api/auth/status', { cookie: session.cookie }); body = await response.json();
  assert.equal(body.authenticated, true); assert.equal(body.username, 'owner'); assert.equal(body.csrf_token, CSRF);
  assert.equal((await f.call('/api/private', { cookie: session.cookie })).status, 200);
  assert.equal((await f.call('/browser/fixture', { cookie: session.cookie })).status, 200);
  assert.equal((await f.call('/api/private', { cookie: session.cookie, raw: '{invalid' })).status, 403);
  assert.equal((await f.call('/api/private', { cookie: session.cookie, body: {}, csrf: 'wrong' })).status, 403);
  assert.equal((await f.call('/api/private', { cookie: session.cookie, body: {}, csrf: CSRF })).status, 200);
  response = await f.call('/api/auth/logout', { cookie: session.cookie, body: {}, csrf: CSRF });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authenticated: false });
  assert.match(response.headers.get('set-cookie')!, /Expires=Thu, 01 Jan 1970/);
  assert.equal(f.security.userForToken(session.token), null); assert.equal(f.security.userForToken(LEGACY_TOKEN), 'owner');
});

test('HTTP requests reject hostile origins, non-JSON, unknown fields, syntax errors and oversized chunked auth bodies without echoing secrets', async t => {
  const f = await httpFixture(t), secret = 'submitted-private-password';
  const cases: [string, Parameters<typeof f.call>[1], number][] = [
    ['/api/auth/login', { body: { username: 'owner', password: secret }, origin: 'https://attacker.example' }, 403],
    ['/api/auth/login', { raw: secret, headers: { 'Content-Type': 'text/plain' } }, 403],
    ['/api/auth/login', { body: { username: 'owner', password: secret, unexpected: secret } }, 422],
    ['/api/auth/login', { raw: '{"password":"' + secret + '",' }, 400],
    ['/api/auth/login', { body: { password: 'x'.repeat(AUTH_BODY_LIMIT) + secret } }, 413],
  ];
  for (const [apiPath, options, status] of cases) {
    const response = await f.call(apiPath, options);
    assert.equal(response.status, status); assert.equal((await response.text()).includes(secret), false);
  }
  const response = await f.call('/api/private', { cookie: `checkin_session=${LEGACY_TOKEN}`, body: {}, csrf: CSRF, origin: 'https://attacker.example' });
  assert.equal(response.status, 403);
  const chunked = await chunkedPost(f.base, '/api/auth/login', JSON.stringify({ username: 'owner', password: 'x'.repeat(AUTH_BODY_LIMIT) + secret }), f.base);
  assert.equal(chunked.status, 413); assert.equal(chunked.body.includes(secret), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 1);
});

test('case-insensitive and trailing-slash Express routes retain authentication, CSRF and auth-body limits', async t => {
  const f = await httpFixture(t);
  for (const apiPath of ['/API/private', '/Api/PrIvAtE/', '/BROWSER/fixture/']) {
    assert.equal((await f.call(apiPath)).status, 401, apiPath);
  }
  assert.equal((await f.call('/API/AUTH/STATUS/')).status, 200);
  const response = await f.call('/API/AUTH/LOGIN/', { body: { username: 'owner', password: PASSWORD } });
  assert.equal(response.status, 200); const session = sessionCookie(response);
  assert.equal((await f.call('/API/PRIVATE/', { cookie: session.cookie, body: {} })).status, 403);
  assert.equal((await f.call('/API/PRIVATE/', { cookie: session.cookie, body: {}, csrf: CSRF })).status, 200);
  assert.equal((await f.call('/API/AUTH/LOGIN/', { body: { password: 'x'.repeat(AUTH_BODY_LIMIT) } })).status, 413);
  const chunked = await chunkedPost(f.base, '/API/AUTH/LOGIN/', JSON.stringify({ password: 'x'.repeat(AUTH_BODY_LIMIT) }), f.base);
  assert.equal(chunked.status, 413);
});

test('HTTPS public URL sets secure cookies and stays authoritative behind a loopback reverse proxy', async t => {
  const f = await httpFixture(t, { config: { publicUrl: 'https://panel.example' } });
  const response = await f.call('/api/auth/login', { body: { username: 'owner', password: PASSWORD }, headers: { 'X-Forwarded-Host': 'attacker.example' } });
  assert.equal(response.status, 200); assert.match(sessionCookie(response).attributes, /; Secure/);
  assert.equal((await f.call('/api/auth/status', { origin: 'http://127.0.0.1', headers: { 'X-Forwarded-Host': '127.0.0.1' } })).status, 403);
  assert.equal((await f.call('/api/auth/status', { origin: 'https://panel.example:443' })).status, 200);
});

test('first-run setup accepts chosen credentials without a token and shares validation failures with login rate limits', async t => {
  const f = fixture(t, { configured: false, config: { loginMaxAttempts: 2 } });
  await f.security.ready;
  assert.equal(f.security.configured, false); assert.equal(existsSync(f.security.setupTokenPath), false);
  const restarted = new WebSecurity(f.store, f.config, CSRF); await restarted.ready;
  assert.equal(existsSync(restarted.setupTokenPath), false);
  await assert.rejects(restarted.login('before-setup-peer', 'owner', PASSWORD), fail(409));
  for (const [index, password] of ['short1!', 'password1234', 'abcdefghijklmnop', '\ud800', 'x'.repeat(1025)].entries()) {
    await assert.rejects(restarted.setup('validation-peer-' + index, 'owner', password), fail(422));
  }
  await assert.rejects(restarted.setup('username-peer', '无效账号', PASSWORD), fail(422));
  await assert.rejects(restarted.setup('missing-peer', undefined, undefined), fail(422));
  assert.equal(restarted.configured, false); assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 0);
  await assert.rejects(restarted.setup('limited-peer', 'owner', 'short1!'), fail(422));
  await assert.rejects(restarted.login('limited-peer', 'owner', 7), fail(401));
  await assert.rejects(restarted.setup('limited-peer', 'owner', PASSWORD), error => fail(429)(error) && Number((error as HttpError).headers!['Retry-After']) > 0);
  const session = await restarted.setup('setup-peer', ' chosen-owner ', PASSWORD);
  assert.equal(session.username, 'chosen-owner'); assert.equal(restarted.configured, true); assert.equal(existsSync(restarted.setupTokenPath), false);
  const stored = f.store.db.prepare('SELECT password_hash FROM web_admin').get()!;
  assert.equal(await verifyPassword(PASSWORD, stored.password_hash), true); assert.equal(JSON.stringify(stored).includes(PASSWORD), false);
  await assert.rejects(restarted.setup('next-peer', 'replacement-owner', 'Another-Administrator-2026!'), fail(409));
  const configured = new WebSecurity(f.store, { ...f.config, adminPassword: 'weak' }, CSRF); await configured.ready;
  assert.equal(configured.userForToken(session.token), 'chosen-owner'); assert.equal(existsSync(configured.setupTokenPath), false);
});

test('HTTP first-run setup needs only username and password, then accepts only the chosen login credentials', async t => {
  const f = await httpFixture(t, { configured: false });
  let response = await f.call('/api/auth/status'), body = await response.json();
  assert.equal(body.setup_required, true); assert.equal(body.configured, false); assert.equal(body.authenticated, false);
  assert.equal('csrf_token' in body, false); assert.equal('setup_token' in body, false);
  assert.equal((await f.call('/api/private')).status, 401);
  response = await f.call('/api/auth/setup', { body: { username: 'my-owner', password: PASSWORD }, origin: 'https://attacker.example' });
  assert.equal(response.status, 403); assert.equal(f.security.configured, false);
  response = await f.call('/api/auth/setup', { body: { username: 'my-owner', password: PASSWORD, setup_token: 'obsolete-token' } });
  assert.equal(response.status, 422); assert.equal(f.security.configured, false);
  response = await f.call('/api/auth/setup', { body: { username: 'my-owner', password: PASSWORD } });
  assert.equal(response.status, 200); body = await response.json();
  assert.deepEqual(body, { authenticated: true, username: 'my-owner', csrf_token: CSRF });
  assert.equal(JSON.stringify(body).includes(PASSWORD), false);
  const session = sessionCookie(response);
  assert.match(session.attributes, /HttpOnly/); assert.match(session.attributes, /SameSite=Strict/);
  response = await f.call('/api/auth/status', { cookie: session.cookie }); body = await response.json();
  assert.equal(body.setup_required, false); assert.equal(body.configured, true); assert.equal(body.authenticated, true); assert.equal(body.username, 'my-owner');
  assert.equal((await f.call('/api/private', { cookie: session.cookie })).status, 200);
  response = await f.call('/api/auth/logout', { cookie: session.cookie, body: {}, csrf: CSRF });
  assert.equal(response.status, 200); assert.equal(f.security.userForToken(session.token), null);
  response = await f.call('/api/auth/status'); body = await response.json();
  assert.equal(body.setup_required, false); assert.equal(body.configured, true); assert.equal(body.authenticated, false);
  for (const credentials of [{ username: 'admin', password: PASSWORD }, { username: 'my-owner', password: 'Wrong-Password-2026!' }]) {
    assert.equal((await f.call('/api/auth/login', { body: credentials })).status, 401);
  }
  response = await f.call('/api/auth/setup', { body: { username: 'replacement-owner', password: 'Another-Administrator-2026!' } });
  assert.equal(response.status, 409);
  response = await f.call('/api/auth/login', { body: { username: 'my-owner', password: PASSWORD } });
  assert.equal(response.status, 200); assert.equal((await response.json()).username, 'my-owner');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get()!.n, 1);
  assert.equal(existsSync(f.security.setupTokenPath), false);
});

test('concurrent first-run setup commits exactly one owner and one session', async t => {
  const f = fixture(t, { configured: false, config: { loginMaxAttempts: 2, loginGlobalMaxAttempts: 2 } });
  assert.equal(existsSync(f.security.setupTokenPath), false);
  const candidates = [{ username: 'first-owner', password: PASSWORD }, { username: 'second-owner', password: 'Another-Administrator-2026!' }];
  const results = await Promise.allSettled([
    f.security.setup('first-peer', candidates[0].username, candidates[0].password),
    f.security.setup('second-peer', candidates[1].username, candidates[1].password),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.find(result => result.status === 'rejected'); assert.ok(loser && loser.status === 'rejected');
  assert.ok(fail(409)(loser.reason));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_admin').get()!.n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const stored = f.store.db.prepare('SELECT username,password_hash FROM web_admin').get()!;
  assert.equal(stored.username, candidates[winner].username);
  assert.equal(await verifyPassword(candidates[winner].password, stored.password_hash), true);
  assert.equal(await verifyPassword(candidates[1 - winner].password, stored.password_hash), false);
  assert.equal(existsSync(f.security.setupTokenPath), false);
});

test('chosen first-run credentials and session survive reopening while environment replacements cannot take ownership', async t => {
  const f = fixture(t, { configured: false });
  const session = await f.security.setup('setup-peer', 'saved-owner', PASSWORD);
  const fingerprint = f.security.adminFingerprint();
  f.store.close();
  const reopened = new Store({ dataDir: f.directory, providers: f.providers, timezone: 'Asia/Shanghai' }); f.stores.push(reopened);
  const security = new WebSecurity(reopened, { ...f.config, adminUser: 'env-replacement', adminPassword: 'Another-Administrator-2026!' }, CSRF);
  await security.ready;
  assert.equal(security.configured, true); assert.equal(security.userForToken(session.token), 'saved-owner');
  assert.equal(security.adminFingerprint(), fingerprint);
  await assert.rejects(security.setup('setup-peer', 'replacement', 'Another-Administrator-2026!'), fail(409));
  await assert.rejects(security.login('env-peer', 'env-replacement', 'Another-Administrator-2026!'), fail(401));
  assert.equal((await security.login('login-peer', 'saved-owner', PASSWORD)).username, 'saved-owner');
  assert.equal(existsSync(security.setupTokenPath), false);
});

test('legacy initialization-token files are removed without being read or logged for both new and configured installs', async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...values: unknown[]) => { warnings.push(values); });
  for (const configured of [false, true]) {
    const f = fixture(t, { configured });
    writeFileSync(f.security.setupTokenPath, 'obsolete-file-with-invalid-token-format\n', { mode: 0o600 });
    const security = new WebSecurity(f.store, f.config, CSRF); await security.ready;
    assert.equal(security.configured, configured); assert.equal(existsSync(security.setupTokenPath), false);
    if (configured) assert.equal(security.userForToken(LEGACY_TOKEN), 'owner');
    else assert.equal((await security.setup('setup-peer', 'chosen-owner', PASSWORD)).username, 'chosen-owner');
  }
  assert.deepEqual(warnings, []);
});

test('environment administrator initialization is asynchronous and weak credentials fail before any owner is created', async t => {
  const f = fixture(t, { configured: false });
  assert.throws(() => new WebSecurity(f.store, { ...f.config, adminPassword: 'password1234' }, CSRF), fail(422));
  assert.throws(() => new WebSecurity(f.store, { ...f.config, adminUser: '无效', adminPassword: PASSWORD }, CSRF), fail(422));
  const security = new WebSecurity(f.store, { ...f.config, adminUser: 'environment-owner', adminPassword: PASSWORD }, CSRF);
  assert.equal(security.configured, false);
  await security.ready;
  assert.equal(security.configured, true); assert.equal(f.store.db.prepare('SELECT username FROM web_admin').get()!.username, 'environment-owner');
  assert.equal(existsSync(security.setupTokenPath), false);
  assert.equal(await verifyPassword(PASSWORD, f.store.db.prepare('SELECT password_hash FROM web_admin').get()!.password_hash), true);
});

test('login reserves per-peer and global slots before asynchronous hashing, then releases them on completion', async t => {
  const f = fixture(t, { Security: GatedSecurity, config: { loginMaxAttempts: 1, loginGlobalMaxAttempts: 2 } });
  const security = f.security as GatedSecurity;
  const first = security.login('first-peer', 'owner', PASSWORD); await pendingCount(security, 1);
  await assert.rejects(security.login('first-peer', 'owner', PASSWORD), fail(429));
  const second = security.login('second-peer', 'owner', PASSWORD); await pendingCount(security, 2);
  await assert.rejects(security.login('third-peer', 'owner', PASSWORD), fail(429));
  security.pending[0].resolve(true); assert.equal((await first).username, 'owner');
  const secondRejected = assert.rejects(second, fail(401)); security.pending[1].resolve(false); await secondRejected;
  await assert.rejects(security.login('second-peer', 'owner', PASSWORD), fail(429));
  const next = security.login('first-peer', 'owner', PASSWORD); await pendingCount(security, 3);
  security.pending[2].resolve(true); assert.equal((await next).username, 'owner');
});

test('login cannot issue a stale session when username or password hash changes while verification awaits', async t => {
  const f = fixture(t, { Security: GatedSecurity }), security = f.security as GatedSecurity;
  const first = security.login('password-peer', 'owner', PASSWORD); await pendingCount(security, 1);
  assert.equal(security.pending[0].encoded, PASSWORD_HASH);
  f.store.db.prepare('UPDATE web_admin SET password_hash=? WHERE id=1').run(PASSWORD_HASH.slice(0, -1) + '0');
  const rejected = assert.rejects(first, fail(401)); security.pending[0].resolve(true); await rejected;
  f.store.db.prepare('UPDATE web_admin SET password_hash=? WHERE id=1').run(PASSWORD_HASH);
  const second = security.login('username-peer', 'owner', PASSWORD); await pendingCount(security, 2);
  f.store.db.prepare('UPDATE web_admin SET username=? WHERE id=1').run('updated-owner');
  const secondRejected = assert.rejects(second, fail(401)); security.pending[1].resolve(true); await secondRejected;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 1);
});

test('verification exceptions release reserved slots so a later login can proceed', async t => {
  const f = fixture(t, { Security: GatedSecurity, config: { loginMaxAttempts: 1, loginGlobalMaxAttempts: 1 } });
  const security = f.security as GatedSecurity;
  const first = security.login('peer', 'owner', PASSWORD); await pendingCount(security, 1);
  const rejected = assert.rejects(first, /fixture verifier failure/); security.pending[0].reject(new Error('fixture verifier failure')); await rejected;
  const second = security.login('peer', 'owner', PASSWORD); await pendingCount(security, 2);
  security.pending[1].resolve(true); assert.equal((await second).username, 'owner');
});

test('global failures cover every peer and rate windows use monotonic time rather than the wall clock', async t => {
  let monotonic = 1000; t.mock.method(performance, 'now', () => monotonic);
  const f = fixture(t, { config: { loginMaxAttempts: 2, loginGlobalMaxAttempts: 2, loginWindowSeconds: 10 } });
  await assert.rejects(f.security.login('first-peer', null, null), fail(401));
  await assert.rejects(f.security.login('second-peer', null, null), fail(401));
  await assert.rejects(f.security.login('third-peer', null, null), error => fail(429)(error) && (error as HttpError).headers!['Retry-After'] === '10');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 86_400_000 });
  await assert.rejects(f.security.login('third-peer', null, null), fail(429));
  monotonic += 11_000;
  await assert.rejects(f.security.login('third-peer', null, null), fail(401));
});

test('password change revokes all prior sessions, changes owner fingerprint and issues only a new secure session', async t => {
  const f = await httpFixture(t, { config: { publicUrl: 'https://panel.example' } });
  const legacyCookie = `checkin_session=${LEGACY_TOKEN}`;
  const other = await f.security.login('other-peer', 'owner', PASSWORD);
  let response = await f.call('/api/auth/password', { cookie: legacyCookie, body: { current_password: 'incorrect', new_password: 'Changed-Administrator-2026!' }, csrf: CSRF });
  assert.equal(response.status, 403); assert.equal(f.security.userForToken(other.token), 'owner');
  response = await f.call('/api/auth/password', { cookie: legacyCookie, body: { current_password: PASSWORD, new_password: 'password1234' }, csrf: CSRF });
  assert.equal(response.status, 422);
  response = await f.call('/api/auth/password', { cookie: legacyCookie, body: { current_password: PASSWORD, new_password: 'Changed-Administrator-2026!' }, csrf: CSRF });
  assert.equal(response.status, 200); const body = await response.json(), session = sessionCookie(response);
  assert.deepEqual(body, { authenticated: true, username: 'owner', csrf_token: CSRF }); assert.match(session.attributes, /; Secure/);
  assert.equal(f.security.userForToken(LEGACY_TOKEN), null); assert.equal(f.security.userForToken(other.token), null);
  assert.equal(f.security.userForToken(session.token), 'owner'); assert.notEqual(f.security.adminFingerprint(), LEGACY_FINGERPRINT);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 1);
  assert.equal(await verifyPassword('Changed-Administrator-2026!', f.store.db.prepare('SELECT password_hash FROM web_admin').get()!.password_hash), true);
  const output = JSON.stringify(body);
  assert.equal(output.includes(PASSWORD), false); assert.equal(output.includes('Changed-Administrator-2026!'), false);
});

test('password change cannot resurrect an administrator session revoked during asynchronous verification', async t => {
  const f = fixture(t, { Security: GatedSecurity }), security = f.security as GatedSecurity;
  const pending = security.changePassword(LEGACY_TOKEN, PASSWORD, 'Changed-Administrator-2026!');
  await pendingCount(security, 1);
  f.store.db.prepare('DELETE FROM web_sessions').run();
  const rejected = assert.rejects(pending, fail(401)); security.pending[0].resolve(true); await rejected;
  assert.equal(f.store.db.prepare('SELECT password_hash FROM web_admin').get()!.password_hash, PASSWORD_HASH);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 0);
  assert.equal(security.adminFingerprint(), LEGACY_FINGERPRINT);
});

test('expired, malformed and foreign session tokens never authorize access and expired digests are cleaned up', t => {
  const f = fixture(t);
  for (const token of [null, undefined, '', 'x'.repeat(31), 'x'.repeat(101), '\n' + LEGACY_TOKEN, 'x'.repeat(43), { token: LEGACY_TOKEN }]) {
    assert.equal(f.security.userForToken(token), null);
  }
  f.store.db.prepare('UPDATE web_sessions SET expires_at=?').run(Date.now() / 1000 - 1);
  assert.equal(f.security.userForToken(LEGACY_TOKEN), null);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').get()!.n, 0);
});

test('owner fingerprint retains Python ensure_ascii and fractional timestamp encoding', t => {
  const f = fixture(t);
  f.store.db.prepare('UPDATE web_admin SET username=?,updated_at=? WHERE id=1').run('旧版🙂', 1735689600.125);
  const spacedPythonJson = '["\\u65e7\\u7248\\ud83d\\ude42", "' + PASSWORD_HASH + '", 1735689600.125]';
  assert.equal(f.security.adminFingerprint(), createHash('sha256').update(spacedPythonJson).digest('hex'));
});
