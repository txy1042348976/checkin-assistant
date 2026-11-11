/** Single-administrator authentication with the original PBKDF2/session schemas. */
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import type { Express, NextFunction, Request, Response } from 'express';
import { HttpError, isRecord } from './errors.js';
import type { Store } from './store.js';
import type { AppConfig } from './types.js';

export const PASSWORD_ITERATIONS = 600_000;
export const MAX_PASSWORD_LENGTH = 1024;
export const AUTH_BODY_LIMIT = 8192;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup']);
const LOGIN_PATHS = new Set(['/api/auth/login', '/api/auth/setup']);
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{2,40}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,100}$/;
const deriveKey = promisify(pbkdf2);

export type SecurityConfig = Pick<AppConfig, 'publicUrl' | 'sessionHours' | 'loginMaxAttempts' | 'loginWindowSeconds' |
  'loginGlobalMaxAttempts' | 'adminUser' | 'adminPassword'> & { enabled?: boolean };
interface Origin { protocol: string; host: string; port: number }
export interface IssuedSession { token: string; username: string; expires: number }
interface Administrator { username: string; password_hash: string; updated_at: number }

function validUnicode(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizedOrigin(value: unknown): Origin | null {
  if (typeof value !== 'string' || !value || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  // Check the unnormalized spelling as well: URL() resolves dot paths and could
  // otherwise turn https://host/../ into an apparently valid root origin.
  const match = /^(https?):\/\/([^/?#]+)\/?$/i.exec(value);
  if (!match || match[2].includes('%')) return null;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !parsed.hostname || parsed.search || parsed.hash || parsed.pathname !== '/') return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return null;
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    return host ? { protocol: parsed.protocol, host, port } : null;
  } catch { return null; }
}

function sameOrigin(left: Origin, right: Origin): boolean {
  return left.protocol === right.protocol && left.host === right.host && left.port === right.port;
}

function validPassword(password: unknown): password is string {
  if (typeof password !== 'string' || !validUnicode(password)) return false;
  const length = Array.from(password).length;
  if (length < 12 || length > MAX_PASSWORD_LENGTH) return false;
  const groups = [/\p{L}/u.test(password), /\p{N}/u.test(password), /[^\p{L}\p{N}\s]/u.test(password)];
  if (groups.filter(Boolean).length < 2) return false;
  const normalized = password.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !new Set(['password1234', 'password12345', 'password123456', 'admin12345678',
    'checkinassistant12345', 'changeme12345', 'changemenow', 'replacethispassword',
    'replacewithasecurepassword', 'yourpasswordhere']).has(normalized);
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || !validUnicode(password) || Array.from(password).length > MAX_PASSWORD_LENGTH) {
    throw new Error('管理员密码格式无效。');
  }
  const salt = randomBytes(16).toString('hex');
  const digest = await deriveKey(password, Buffer.from(salt, 'hex'), PASSWORD_ITERATIONS, 32, 'sha256');
  return `pbkdf2_sha256$${PASSWORD_ITERATIONS}$${salt}$${digest.toString('hex')}`;
}

export async function verifyPassword(password: unknown, encoded: unknown): Promise<boolean> {
  if (typeof password !== 'string' || typeof encoded !== 'string' || !validUnicode(password) || Array.from(password).length > MAX_PASSWORD_LENGTH) return false;
  const fields = encoded.split('$');
  if (fields.length !== 4) return false;
  const [method, iterations, salt, expected] = fields;
  if (method !== 'pbkdf2_sha256' || !/^[0-9]+$/.test(iterations) || !/^[0-9a-fA-F]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  const count = Number(iterations);
  if (!Number.isSafeInteger(count) || count < 100_000 || count > 2_000_000) return false;
  const actual = await deriveKey(password, Buffer.from(salt, 'hex'), count, 32, 'sha256');
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

function asciiJsonString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Python json.dumps(float) spelling used by existing browser-import owners. */
function pythonFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error('管理员设置数据异常。');
  if (Object.is(value, -0)) return '-0.0';
  let text = value.toString();
  if (value !== 0 && (Math.abs(value) >= 1e16 || Math.abs(value) < 1e-4)) text = value.toExponential();
  if (text.includes('e')) {
    const [mantissa, power] = text.split('e');
    const exponent = Number(power);
    return mantissa + 'e' + (exponent >= 0 ? '+' : '-') + String(Math.abs(exponent)).padStart(2, '0');
  }
  return text.includes('.') ? text : text + '.0';
}

function positiveConfig(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(label + ' 配置无效。');
  return value;
}

export class WebSecurity {
  readonly store: Store;
  readonly enabled: boolean;
  readonly csrfToken: string;
  readonly publicUrl: string;
  readonly cookieName = 'checkin_session';
  /** Legacy token files are removed; first-run setup no longer needs a token. */
  readonly setupTokenPath: string;
  readonly ready: Promise<void>;
  private readonly publicOrigin: Origin | null;
  private readonly sessionSeconds: number;
  private readonly loginMaxAttempts: number;
  private readonly loginWindow: number;
  private readonly globalMaxAttempts: number;
  private readonly failures = new Map<string, number[]>();
  private globalFailures: number[] = [];
  private readonly inflight = new Map<string, number>();

  constructor(store: Store, config: SecurityConfig, csrfToken: string) {
    this.store = store;
    this.enabled = config.enabled ?? true;
    this.csrfToken = csrfToken;
    this.publicUrl = config.publicUrl.trim().replace(/\/+$/, '');
    this.publicOrigin = this.publicUrl ? normalizedOrigin(this.publicUrl) : null;
    if (this.publicUrl && !this.publicOrigin) throw new Error('CHECKIN_PUBLIC_URL 必须是完整的 HTTP 或 HTTPS 根网址。');
    this.sessionSeconds = positiveConfig(config.sessionHours, 720, 'CHECKIN_SESSION_HOURS') * 3600;
    this.loginMaxAttempts = positiveConfig(config.loginMaxAttempts, 100, 'CHECKIN_LOGIN_MAX_ATTEMPTS');
    this.loginWindow = positiveConfig(config.loginWindowSeconds, 86400, 'CHECKIN_LOGIN_WINDOW_SECONDS');
    this.globalMaxAttempts = positiveConfig(config.loginGlobalMaxAttempts, 1000, 'CHECKIN_LOGIN_GLOBAL_MAX_ATTEMPTS');
    this.setupTokenPath = path.join(path.dirname(store.dbPath), 'web-setup-token');
    if (!this.enabled) { this.ready = Promise.resolve(); return; }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS web_admin (
        id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES web_admin(id) ON DELETE CASCADE,
        created_at REAL NOT NULL, expires_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_sessions_expires ON web_sessions(expires_at);
    `);
    this.removeSetupToken();
    // Ignore replacement environment passwords when migrating an existing owner.
    if (this.configured) { this.ready = Promise.resolve(); return; }
    if (config.adminPassword) {
      const username = this.validateUsername(config.adminUser);
      this.validatePassword(config.adminPassword);
      this.ready = this.initializePassword(username, config.adminPassword);
    } else this.ready = Promise.resolve();
  }

  private async initializePassword(username: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    this.store.transaction(() => {
      if (this.configured) return;
      const now = Date.now() / 1000;
      this.store.db.prepare('INSERT INTO web_admin VALUES(1,?,?,?,?)').run(username, hash, now, now);
      this.removeSetupToken();
    });
  }

  get configured(): boolean {
    return !this.enabled || Boolean(this.store.db.prepare('SELECT 1 FROM web_admin WHERE id=1').get());
  }

  adminFingerprint(): string {
    const row = this.store.db.prepare('SELECT username,password_hash,updated_at FROM web_admin WHERE id=1').get() as unknown as Administrator | undefined;
    if (!row) throw new HttpError(401, '请先初始化并登录管理员账号。');
    const serialized = `[${asciiJsonString(row.username)}, ${asciiJsonString(row.password_hash)}, ${pythonFloat(row.updated_at)}]`;
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
  }

  originAllowed(origin: string | undefined | null, host: string | undefined | null): boolean {
    const actual = normalizedOrigin(origin);
    if (!actual) return false;
    if (this.publicOrigin) return sameOrigin(actual, this.publicOrigin);
    if (typeof host !== 'string' || !host) return false;
    const target = normalizedOrigin(host.includes('://') ? host : actual.protocol + '//' + host);
    return target !== null && sameOrigin(actual, target);
  }

  userForToken(token: unknown): string | null {
    if (!this.enabled || typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const digest = createHash('sha256').update(token, 'ascii').digest('hex');
    const row = this.store.db.prepare('SELECT a.username,s.expires_at FROM web_sessions s JOIN web_admin a ON a.id=s.admin_id WHERE s.token_hash=?').get(digest);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now() / 1000) {
      this.store.db.prepare('DELETE FROM web_sessions WHERE token_hash=?').run(digest);
      return null;
    }
    return String(row.username);
  }

  private removeSetupToken(): void {
    try { unlinkSync(this.setupTokenPath); }
    catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
  }

  private validateUsername(value: unknown): string {
    if (typeof value !== 'string' || !USERNAME_PATTERN.test(value.trim())) throw new HttpError(422, '管理员账号须为 2–40 个英文字母、数字、点、下划线或连字符。');
    return value.trim();
  }

  private validatePassword(value: unknown): asserts value is string {
    if (!validPassword(value)) throw new HttpError(422, '密码须为 12–1024 个字符，包含字母、数字或符号中的至少两类，并避免常见默认密码。');
  }

  private pruneFailures(): void {
    const threshold = performance.now() / 1000 - this.loginWindow;
    this.globalFailures = this.globalFailures.filter(value => value > threshold);
    for (const [peer, values] of this.failures) {
      const remaining = values.filter(value => value > threshold);
      if (remaining.length) this.failures.set(peer, remaining);
      else this.failures.delete(peer);
    }
  }

  private beginAttempt(peer: string): void {
    this.pruneFailures();
    const peerFailures = this.failures.get(peer) ?? [];
    const applicable = [];
    if (peerFailures.length >= this.loginMaxAttempts) applicable.push(peerFailures[0]);
    if (this.globalFailures.length >= this.globalMaxAttempts) applicable.push(this.globalFailures[0]);
    const retry = applicable.length ? Math.max(1, Math.ceil(Math.max(...applicable) + this.loginWindow - performance.now() / 1000)) : 0;
    const inflightTotal = [...this.inflight.values()].reduce((sum, value) => sum + value, 0);
    if (retry || peerFailures.length + (this.inflight.get(peer) ?? 0) >= this.loginMaxAttempts || this.globalFailures.length + inflightTotal >= this.globalMaxAttempts) {
      throw new HttpError(429, '登录尝试过于频繁，请稍后再试。', { headers: { 'Retry-After': String(retry || 1) } });
    }
    this.inflight.set(peer, (this.inflight.get(peer) ?? 0) + 1);
  }

  private endAttempt(peer: string): void {
    const count = (this.inflight.get(peer) ?? 0) - 1;
    if (count > 0) this.inflight.set(peer, count);
    else this.inflight.delete(peer);
  }

  private recordFailure(peer: string): void {
    this.pruneFailures();
    const now = performance.now() / 1000;
    this.failures.set(peer, [...(this.failures.get(peer) ?? []), now]);
    this.globalFailures.push(now);
  }

  protected async verifyHash(password: string, encoded: string): Promise<boolean> {
    return verifyPassword(password, encoded);
  }

  private issueSession(): IssuedSession {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT username FROM web_admin WHERE id=1').get();
      if (!row) throw new HttpError(409, '管理员账号尚未配置。');
      const token = randomBytes(32).toString('base64url');
      const now = Date.now() / 1000, expires = now + this.sessionSeconds;
      this.store.db.prepare('DELETE FROM web_sessions WHERE expires_at<=?').run(now);
      this.store.db.prepare('INSERT INTO web_sessions VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), 1, now, expires);
      return { token, username: String(row.username), expires };
    });
  }

  async login(peer: string, username: unknown, password: unknown): Promise<IssuedSession> {
    await this.ready;
    this.beginAttempt(peer);
    try {
      if (typeof username !== 'string' || typeof password !== 'string' || !validUnicode(password) || Array.from(password).length > MAX_PASSWORD_LENGTH) {
        this.recordFailure(peer);
        throw new HttpError(401, '管理员账号或密码不正确。');
      }
      const row = this.store.db.prepare('SELECT username,password_hash FROM web_admin WHERE id=1').get() as unknown as Administrator | undefined;
      if (!row) throw new HttpError(409, '请先完成管理员初始化。');
      const passwordOk = await this.verifyHash(password, row.password_hash);
      const candidate = username.trim();
      const usernameOk = USERNAME_PATTERN.test(candidate) && equal(candidate, row.username);
      if (!usernameOk || !passwordOk) { this.recordFailure(peer); throw new HttpError(401, '管理员账号或密码不正确。'); }
      return this.store.transaction(() => {
        const current = this.store.db.prepare('SELECT username,password_hash FROM web_admin WHERE id=1').get();
        if (!current || !equal(String(current.password_hash), row.password_hash) || !equal(String(current.username), row.username)) throw new HttpError(401, '登录状态发生变化，请重新登录。');
        this.failures.delete(peer);
        return this.issueSession();
      });
    } finally { this.endAttempt(peer); }
  }

  async setup(peer: string, username: unknown, password: unknown): Promise<IssuedSession> {
    await this.ready;
    this.beginAttempt(peer);
    try {
      if (this.configured) throw new HttpError(409, '管理员账号已经配置。');
      let validatedUsername: string;
      try {
        validatedUsername = this.validateUsername(username);
        this.validatePassword(password);
      } catch (error) {
        if (error instanceof HttpError) this.recordFailure(peer);
        throw error;
      }
      const hash = await hashPassword(password);
      return this.store.transaction(() => {
        if (this.configured) throw new HttpError(409, '管理员账号已经配置。');
        const now = Date.now() / 1000;
        this.store.db.prepare('INSERT INTO web_admin VALUES(1,?,?,?,?)').run(validatedUsername, hash, now, now);
        this.removeSetupToken();
        this.failures.delete(peer);
        return this.issueSession();
      });
    } finally { this.endAttempt(peer); }
  }

  async changePassword(token: unknown, currentPassword: unknown, newPassword: unknown): Promise<IssuedSession> {
    await this.ready;
    if (!this.userForToken(token)) throw new HttpError(401, '登录已过期，请重新登录。');
    const row = this.store.db.prepare('SELECT password_hash FROM web_admin WHERE id=1').get();
    const hash = String(row?.password_hash);
    if (typeof currentPassword !== 'string' || !await this.verifyHash(currentPassword, hash)) throw new HttpError(403, '当前密码不正确。');
    this.validatePassword(newPassword);
    const updatedHash = await hashPassword(newPassword);
    return this.store.transaction(() => {
      const current = this.store.db.prepare('SELECT password_hash FROM web_admin WHERE id=1').get();
      if (!this.userForToken(token) || !current || !equal(String(current.password_hash), hash)) throw new HttpError(401, '登录状态发生变化，请重新登录。');
      this.store.db.prepare('UPDATE web_admin SET password_hash=?,updated_at=? WHERE id=1').run(updatedHash, Date.now() / 1000);
      this.store.db.prepare('DELETE FROM web_sessions').run();
      return this.issueSession();
    });
  }

  private requestToken(request: Request): string | undefined {
    const header = request.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== this.cookieName) continue;
      try { return decodeURIComponent(part.slice(separator + 1).trim()); }
      catch { return undefined; }
    }
    return undefined;
  }

  /** Synchronous policy assertion; callers must first await security.ready. */
  assertRequestAuthorized(request: Request): string | null {
    if (!this.enabled) return 'local';
    const origin = request.get('origin');
    if (origin !== undefined && !this.originAllowed(origin, request.get('host'))) throw new HttpError(403, '请求来源不受信任。');
    // Cover every spelling that could otherwise reach an Express route.
    const requestPath = request.path.toLowerCase().replace(/\/+$/, '') || '/';
    const protectedPath = ((requestPath === '/api' || requestPath.startsWith('/api/')) && !PUBLIC_API_PATHS.has(requestPath)) || requestPath === '/browser' || requestPath.startsWith('/browser/');
    const username = this.userForToken(this.requestToken(request));
    if (protectedPath && username === null) throw new HttpError(401, '请先登录管理员账号。');
    if (MUTATING_METHODS.has(request.method)) {
      if ((request.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new HttpError(403, '请求须使用 JSON 格式。');
      if (!LOGIN_PATHS.has(requestPath) && !equal(request.get('x-csrf-token') ?? '', this.csrfToken)) throw new HttpError(403, '请求校验失败，请刷新页面后重试。');
    }
    if (requestPath.startsWith('/api/auth/')) {
      const size = request.get('content-length');
      if (size !== undefined && (!/^[0-9]+$/.test(size) || Number(size) > AUTH_BODY_LIMIT)) throw new HttpError(413, '登录请求内容过长。');
    }
    return username;
  }

  guard = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      await this.ready;
      response.locals.webUser = this.assertRequestAuthorized(request);
      next();
    } catch (error) {
      if (error instanceof HttpError) {
        for (const [key, value] of Object.entries(error.headers ?? {})) response.setHeader(key, value);
        response.setHeader('Cache-Control', 'no-store');
        response.status(error.status).json({ detail: error.message });
      } else next(error);
    }
  };

  private readBody(request: Request, allowed: string[]): Record<string, unknown> {
    if (request.body === undefined) throw new HttpError(400, '请求内容格式无效。');
    if (!isRecord(request.body) || Object.keys(request.body).some(key => !allowed.includes(key))) throw new HttpError(422, '请求字段不完整或格式无效。');
    return request.body;
  }

  private sessionResponse(request: Request, response: Response, session: IssuedSession): void {
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(this.cookieName, session.token, { path: '/', httpOnly: true, sameSite: 'strict',
      secure: this.publicOrigin?.protocol === 'https:' || request.secure, maxAge: this.sessionSeconds * 1000,
      expires: new Date(session.expires * 1000) });
    response.json({ authenticated: true, username: session.username, csrf_token: this.csrfToken });
  }

  installRoutes(app: Express): void {
    app.get('/api/auth/status', async (request, response) => {
      await this.ready;
      const username = this.enabled ? this.userForToken(this.requestToken(request)) : 'local';
      response.setHeader('Cache-Control', 'no-store');
      response.json({ web_mode: this.enabled, configured: this.configured, authenticated: username !== null,
        username, setup_required: this.enabled && !this.configured, ...(username !== null ? { csrf_token: this.csrfToken } : {}) });
    });
    app.post('/api/auth/login', async (request, response) => {
      if (!this.enabled) throw new HttpError(409, '当前为本机桌面模式。');
      const body = this.readBody(request, ['username', 'password']);
      const session = await this.login(request.ip ?? request.socket.remoteAddress ?? 'unknown', body.username, body.password);
      this.sessionResponse(request, response, session);
    });
    app.post('/api/auth/setup', async (request, response) => {
      if (!this.enabled) throw new HttpError(409, '当前为本机桌面模式。');
      const body = this.readBody(request, ['username', 'password']);
      const session = await this.setup(request.ip ?? request.socket.remoteAddress ?? 'unknown', body.username, body.password);
      this.sessionResponse(request, response, session);
    });
    app.post('/api/auth/logout', async (request, response) => {
      await this.ready;
      const token = this.requestToken(request);
      if (this.enabled && token && TOKEN_PATTERN.test(token)) this.store.db.prepare('DELETE FROM web_sessions WHERE token_hash=?').run(createHash('sha256').update(token).digest('hex'));
      response.setHeader('Cache-Control', 'no-store');
      response.clearCookie(this.cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: this.publicOrigin?.protocol === 'https:' || request.secure });
      response.json({ authenticated: !this.enabled });
    });
    app.post('/api/auth/password', async (request, response) => {
      if (!this.enabled) throw new HttpError(409, '当前为本机桌面模式。');
      const body = this.readBody(request, ['current_password', 'new_password']);
      const session = await this.changePassword(this.requestToken(request), body.current_password, body.new_password);
      this.sessionResponse(request, response, session);
    });
  }
}
