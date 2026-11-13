import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { BrowserResources } from './browser-resources.js';
import { BrowserSession } from './engine.js';
import { HttpError, boundedString, isRecord, requireRecord } from './errors.js';
import { normalizeProxy, resolveProxy } from './proxy.js';
import { isSub2API, profileId, profileSnapshot, responseData } from './protocols.js';
import { supports } from './providers.js';
import { guardedResponse, httpRequest } from './transport.js';
import type { Store } from './store.js';
import type { WebSecurity } from './security.js';
import type { AppConfig, CookieData, ImportPayload, ImportView, LoginMethod, Profile, Provider, ProxyConfig } from './types.js';

export const IMPORT_SECONDS = 20 * 60;
export const IMPORT_PATH = /^\/api\/browser-import\/([a-f0-9]{32})$/;
export const IMPORT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_IMPORT_BYTES = 512 * 1024;
const ACTIVE = new Set(['waiting', 'verifying']);
const SECRET = /^[\x21-\x7e]+$/;

interface ImportContext {
  provider: string;
  method: LoginMethod;
  name: string;
  target_account_id: number | null;
  interval_hours: number;
  proxy: ProxyConfig;
  provider_signature: string;
  provider_view: Record<string, unknown>;
  origin: string;
  ticket: string;
  manual_request_hash?: string;
}

interface ImportRow {
  id: string;
  ticket_hash: string;
  owner_fingerprint: string;
  created_at: number;
  expires_at: number;
  status: ImportView['status'];
  encrypted_context: string;
  account_id: number | null;
  message: string;
  attempts: number;
}

export interface StartImport {
  provider: string;
  method: LoginMethod;
  name?: string;
  account_id?: number | null;
  interval_hours: number;
  proxy?: ProxyConfig;
  origin: string;
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

export function providerSignature(provider: Provider): string {
  return hash(JSON.stringify(stable({ ...provider, waf_cookie_names: [...provider.waf_cookie_names].sort() })));
}

export function providerView(provider: Provider): Record<string, unknown> {
  return { id: provider.name, name: provider.display_name || provider.name, domain: provider.domain,
    login_path: provider.login_path, user_info_path: provider.user_info_path, api_user_key: provider.api_user_key,
    template: provider.template, custom: provider.custom, waf_cookie_names: [...provider.waf_cookie_names] };
}

function manualRequestHash(context: Pick<ImportContext, 'provider' | 'method' | 'name' | 'target_account_id' | 'interval_hours' | 'proxy' | 'provider_signature'>,
  payload: ImportPayload): string {
  return hash(JSON.stringify(stable({ provider: context.provider, method: context.method, name: context.name,
    account_id: context.target_account_id, interval_hours: context.interval_hours, proxy: context.proxy,
    provider_signature: context.provider_signature, payload })));
}

function secret(value: unknown, nullable = false): string | null {
  if (nullable && (value === undefined || value === null)) return null;
  const result = boundedString(value, 1, 32_000);
  if (!SECRET.test(result) || /[;,]/.test(result)) throw new HttpError(422, '登录凭据格式无效。');
  return result;
}

export function parseImportPayload(value: unknown): ImportPayload {
  const body = requireRecord(value);
  const allowed = new Set(['session', 'api_user', 'site_cookies', 'oauth_cookies', 'oauth_user_agent', 'refresh_token']);
  if (Object.keys(body).some(key => !allowed.has(key))) throw new HttpError(422, '导入请求包含不支持的字段。');
  const user = boundedString(body.api_user, 1, 100);
  if (!/^[0-9]{1,100}$/.test(user) || BigInt(user) <= 0n) throw new HttpError(422, '请输入站点返回的有效用户 ID。');
  const userAgent = body.oauth_user_agent === null || body.oauth_user_agent === undefined ? '' : boundedString(body.oauth_user_agent, 0, 1000, false);
  if (/[^\x20-\x7e]/.test(userAgent)) throw new HttpError(422, '浏览器信息格式无效。');
  const arrays = ['site_cookies', 'oauth_cookies'] as const;
  for (const key of arrays) {
    const items = body[key] ?? [];
    if (!Array.isArray(items) || items.length > (key === 'site_cookies' ? 30 : 80) || items.some(item => !isRecord(item))) {
      throw new HttpError(422, 'Cookie 导出数据格式无效，请重新导入。');
    }
  }
  return { session: secret(body.session)!, api_user: BigInt(user).toString(),
    site_cookies: (body.site_cookies ?? []) as CookieData[], oauth_cookies: (body.oauth_cookies ?? []) as CookieData[],
    oauth_user_agent: userAgent, refresh_token: secret(body.refresh_token, true) };
}

export function normalizeImportCookies(items: CookieData[], options: { host?: string; names?: Set<string>; roots?: string[] } = {}): CookieData[] {
  const result: CookieData[] = [], seen = new Set<string>();
  for (const raw of items) {
    const item = raw as unknown as Record<string, unknown>;
    const name = item.name, value = item.value, domain = item.domain, cookiePath = item.path ?? '/';
    if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~a-zA-Z0-9-]{1,128}$/.test(name)
      || typeof value !== 'string' || !value || value.length > 32_000 || !SECRET.test(value) || /[;,]/.test(value)
      || typeof domain !== 'string' || typeof cookiePath !== 'string' || !cookiePath.startsWith('/')
      || cookiePath.length > 1024 || /[^\x20-\x7e]/.test(cookiePath)
      || 'partitionKey' in item || '_crHasCrossSiteAncestor' in item || item.partitioned === true) {
      throw new HttpError(422, 'Cookie 导出数据格式无效，请重新导入。');
    }
    const normalizedDomain = domain.replace(/^\.+/, '').toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalizedDomain) || normalizedDomain.includes('..')
      || (options.host !== undefined && normalizedDomain !== options.host)
      || (options.names !== undefined && !options.names.has(name))
      || (options.roots?.length && !options.roots.some(root => normalizedDomain === root || normalizedDomain.endsWith('.' + root)))) {
      throw new HttpError(422, 'Cookie 包含当前授权范围之外的站点或字段。');
    }
    const expires = item.expires ?? item.expirationDate ?? -1;
    if (typeof expires !== 'number' || !Number.isFinite(expires)) throw new HttpError(422, 'Cookie 有效期格式无效。');
    if (expires > 0 && expires <= Date.now() / 1000) continue;
    const sameSiteMap: Record<string, string | undefined> = { no_restriction: 'None', lax: 'Lax', strict: 'Strict', unspecified: undefined };
    let sameSite = item.sameSite;
    if (typeof sameSite === 'string' && Object.hasOwn(sameSiteMap, sameSite)) sameSite = sameSiteMap[sameSite];
    if (sameSite !== undefined && sameSite !== null && !['None', 'Lax', 'Strict'].includes(String(sameSite))) throw new HttpError(422, 'Cookie SameSite 格式无效。');
    const cookie: CookieData = { name, value, domain: (domain.startsWith('.') ? '.' : '') + normalizedDomain,
      path: cookiePath, expires: expires > 0 ? expires : -1 };
    for (const flag of ['secure', 'httpOnly'] as const) {
      if (flag in item) {
        if (typeof item[flag] !== 'boolean') throw new HttpError(422, 'Cookie 安全属性格式无效。');
        cookie[flag] = item[flag];
      }
    }
    if (sameSite === 'None' && cookie.secure !== true) throw new HttpError(422, 'SameSite=None Cookie 必须使用 Secure 属性，请重新导入。');
    if (sameSite !== undefined && sameSite !== null) cookie.sameSite = sameSite as CookieData['sameSite'];
    const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
    if (seen.has(key)) throw new HttpError(422, 'Cookie 导出数据含重复项。');
    seen.add(key); result.push(cookie);
  }
  return result;
}

export async function verifyImportProfile(provider: Provider, payload: ImportPayload, proxy: ProxyConfig, config: AppConfig, signal?: AbortSignal, browserResources?: BrowserResources): Promise<Profile> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest',
    'Cache-Control': 'no-cache', Referer: provider.domain + provider.login_path };
  const target = new URL(provider.user_info_path, provider.domain);
  if (target.origin !== new URL(provider.domain).origin) throw new HttpError(422, '站点接口配置无效。');
  const cookies = payload.site_cookies.filter(item => {
    const cookiePath = item.path || '/';
    return (!item.secure || target.protocol === 'https:')
      && (!item.expires || item.expires <= 0 || item.expires > Date.now() / 1000)
      && (target.pathname === cookiePath || target.pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/'));
  }).sort((left, right) => right.path.length - left.path.length).map(item => `${item.name}=${item.value}`);
  if (isSub2API(provider)) {
    headers.Authorization = 'Bearer ' + payload.session;
    headers['X-User-UI-Request'] = '1';
  } else {
    cookies.push('session=' + payload.session); headers[provider.api_user_key] = payload.api_user;
  }
  if (cookies.length) headers.Cookie = cookies.join('; ');
  if (payload.oauth_user_agent) headers['User-Agent'] = payload.oauth_user_agent;
  target.searchParams.set('_checkin_assistant_verify', randomBytes(12).toString('base64url'));
  try {
    let response = await httpRequest(target.href, { method: 'GET', headers, provider, proxy, config, timeoutMs: 20_000, maxBytes: 512 * 1024, signal });
    if (provider.bypass_method === 'waf_cookies' && provider.waf_cookie_names.length && guardedResponse(response)) {
      const browserSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
      const browser = new BrowserSession(provider, config, resolveProxy(provider, proxy, config), browserSignal, browserResources);
      const abortBrowser = () => { void browser.close().catch(() => {}); };
      browserSignal.addEventListener('abort', abortBrowser, { once: true });
      try {
        await browser.start({ session: payload.session, api_user: payload.api_user,
          site_cookies: payload.site_cookies, oauth_user_agent: payload.oauth_user_agent });
        if (await browser.session() !== payload.session) throw new HttpError(422, '校验中原站登录状态已变化，请重新复制 Session 后保存。');
        response = await browser.request(provider.user_info_path, payload.api_user, 'GET');
        if (await browser.session() !== payload.session) throw new HttpError(422, '校验中原站登录状态已变化，请重新复制 Session 后保存。');
      } finally {
        browserSignal.removeEventListener('abort', abortBrowser);
        await browser.close();
      }
    }
    if (response.status === 401 || response.status === 403) throw new HttpError(422, '后台未能验证站点登录状态，请确认已登录并重新导入；站点也可能限制了服务器网络。');
    if (response.status !== 200) throw new HttpError(422, '站点暂时无法校验账号，尚未保存。请稍后重试或检查后台网络代理。');
    if (!/application\/(?:[\w.-]+\+)?json\b/i.test(response.headers['content-type'] || '')) throw new HttpError(422, '站点防护阻止了后台校验，尚未保存。请检查服务器网络或代理后重新导入。');
    const profile = responseData(response.body, provider);
    if (!isRecord(profile) || profileId(profile.id) !== payload.api_user) {
      throw new HttpError(422, '登录凭据与用户 ID 不一致，尚未保存。请从同一站点账号重新导入。');
    }
    return profile as Profile;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, '后台无法连接站点完成校验，尚未保存。请检查服务器网络或账号代理后重试。');
  }
}

export class UserBrowserImports {
  private controllers = new Map<string, AbortController>();
  private tasks = new Set<Promise<ImportView>>();
  private manualTasks = new Map<string, Promise<ImportView>>();
  private stopping = false;
  private verify: typeof verifyImportProfile;

  constructor(private store: Store, private providers: Record<string, Provider>, private security: WebSecurity,
    private config: AppConfig, private accountBusy: (id: number) => boolean = () => false,
    verifier: typeof verifyImportProfile = verifyImportProfile, private browserResources?: BrowserResources,
    private manualOnly = false) {
    this.verify = verifier;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS browser_imports (
      id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL, owner_fingerprint TEXT NOT NULL,
      created_at REAL NOT NULL, expires_at REAL NOT NULL, status TEXT NOT NULL,
      encrypted_context TEXT NOT NULL, account_id INTEGER, message TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS browser_imports_expiry ON browser_imports(expires_at);`);
    const interrupted = this.store.db.prepare("SELECT * FROM browser_imports WHERE status IN ('waiting','verifying')").all() as unknown as ImportRow[];
    for (const row of interrupted) {
      if (this.manualOnly && !this.context(row).manual_request_hash) {
        this.store.db.prepare("UPDATE browser_imports SET status='cancelled',message=? WHERE id=?")
          .run('请在账号表单手动填写并保存账号。', row.id);
      } else if (this.context(row).manual_request_hash) {
        this.store.db.prepare("UPDATE browser_imports SET status='failed',message=? WHERE id=?")
          .run('上次保存被中断，请重新填写原站登录凭据并保存。', row.id);
      } else if (row.status === 'verifying') {
        this.store.db.prepare("UPDATE browser_imports SET status='waiting',message=? WHERE id=?")
          .run('上次校验被中断，请重新填写原站登录凭据并保存。', row.id);
      }
    }
  }

  private context(row: ImportRow): ImportContext { return this.store.decryptCredentials(row.encrypted_context) as unknown as ImportContext; }

  private row(id: string): ImportRow | undefined {
    let row = this.store.db.prepare('SELECT * FROM browser_imports WHERE id=?').get(id) as unknown as ImportRow | undefined;
    if (row && ACTIVE.has(row.status)) {
      let status: 'expired' | 'cancelled' | undefined, message = '';
      if (row.expires_at <= Date.now() / 1000) { status = 'expired'; message = '连接码已过期，请重新开始账号连接。'; }
      else if (!equal(row.owner_fingerprint, this.security.adminFingerprint())) { status = 'cancelled'; message = '管理员登录设置已更新，请重新开始账号连接。'; }
      else {
        const context = this.context(row), provider = this.providers[context.provider];
        if (!provider || !provider.active || !equal(providerSignature(provider), context.provider_signature)) {
          status = 'cancelled'; message = '站点配置或服务版本已变化，请重新开始账号连接。';
        }
      }
      if (status) {
        this.store.db.prepare('UPDATE browser_imports SET status=?,message=? WHERE id=?').run(status, message, id);
        this.controllers.get(id)?.abort();
        row = this.store.db.prepare('SELECT * FROM browser_imports WHERE id=?').get(id) as unknown as ImportRow;
      }
    }
    return row;
  }

  private rowView(row: ImportRow, connection = true, detailed = false): ImportView {
    const context = this.context(row);
    const result: ImportView = { id: row.id, provider: detailed ? context.provider_view : context.provider,
      method: context.method, name: context.name, status: row.status, stage: 'user_browser', message: row.message,
      account_id: row.account_id || context.target_account_id, elapsed: Math.max(0, Math.floor(Date.now() / 1000 - row.created_at)),
      expires_at: new Date(row.expires_at * 1000).toISOString(),
      browser_url: String(context.provider_view.domain) + String(context.provider_view.login_path),
      verification_paused: false, verification_auto: false, oauth_continue_available: false };
    if (connection && ACTIVE.has(row.status)) result.connection = { version: 1, origin: context.origin, id: row.id, ticket: context.ticket };
    return result;
  }

  view(id: string): ImportView | null { const row = this.row(id); return row ? this.rowView(row) : null; }

  current(includeManual = true): ImportView | null {
    const rows = this.store.db.prepare("SELECT id FROM browser_imports WHERE status IN ('waiting','verifying') ORDER BY created_at DESC").all() as { id: string }[];
    for (const candidate of rows) {
      const row = this.row(candidate.id);
      if (row && ACTIVE.has(row.status) && (includeManual || !this.context(row).manual_request_hash)) return this.rowView(row);
    }
    return null;
  }

  isAuthorizing(id: number): boolean { return this.current()?.account_id === id; }
  providerPending(id: string): boolean { return this.current()?.provider === id; }

  start(input: StartImport): ImportView { return this.createImport(input); }

  private createImport(input: StartImport, request?: { id: string; hash: string }): ImportView {
    if (this.stopping) throw new HttpError(409, '服务正在停止，请稍后重新连接。');
    if (!supports(this.providers, input.provider, input.method)) throw new HttpError(422, '站点或登录方式不可用。');
    if (this.current()) throw new HttpError(409, '已有账号正在等待填写或校验，请先完成或取消当前操作。');
    const target = input.account_id ?? null;
    let previousProxy: ProxyConfig | undefined;
    if (target !== null) {
      const account = this.store.account(target);
      if (!account) throw new HttpError(404, '账号不存在。');
      if (account.provider !== input.provider) throw new HttpError(409, '重新授权的平台必须与原账号一致。');
      if (['queued', 'running'].includes(account.status) || this.accountBusy(target)) throw new HttpError(409, '账号正在排队或运行，暂不能重新连接。');
      previousProxy = this.store.credentials(account).proxy;
    }
    const provider = this.providers[input.provider], ticket = randomBytes(32).toString('base64url'), id = request?.id || randomUUID().replace(/-/g, '');
    const context: ImportContext = { provider: input.provider, method: input.method, name: input.name || '',
      target_account_id: target, interval_hours: input.interval_hours, proxy: normalizeProxy(input.proxy, previousProxy),
      provider_signature: providerSignature(provider), provider_view: providerView(provider), origin: input.origin, ticket,
      ...(request ? { manual_request_hash: request.hash } : {}) };
    const now = Date.now() / 1000;
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO browser_imports(id,ticket_hash,owner_fingerprint,created_at,expires_at,status,encrypted_context,message) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, hash(ticket), this.security.adminFingerprint(), now, now + IMPORT_SECONDS, 'waiting', this.store.encryptCredentials(context),
          this.manualOnly ? '请手动填写本站 Session 和用户 ID，保存后在首次运行时验证。'
            : '请在原站登录后填写本站 Session 和用户 ID，后台确认身份与余额后保存。');
      this.store.db.prepare("DELETE FROM browser_imports WHERE expires_at<? AND status NOT IN ('waiting','verifying')").run(now - 86400);
    });
    return this.view(id)!;
  }

  importManual(input: StartImport, data: unknown, requestId: string): Promise<ImportView> {
    if (this.stopping) return Promise.reject(new HttpError(409, '服务正在停止，请稍后重新保存。'));
    try {
      if (!/^[a-f0-9]{32}$/.test(requestId) || input.method !== 'manual') throw new HttpError(422, '保存请求标识无效，请重新打开表单。');
      const payload = parseImportPayload(data);
      if (payload.site_cookies.length || payload.oauth_cookies.length || payload.oauth_user_agent) throw new HttpError(422, '手动填写只接收本站登录凭据和用户 ID。');
      const provider = this.providers[input.provider];
      if (!provider?.active || !supports(this.providers, input.provider, 'manual')) throw new HttpError(422, '站点或登录方式不可用。');
      const existing = this.row(requestId), oldContext = existing ? this.context(existing) : null;
      const target = input.account_id ?? null;
      const previous = target === null ? undefined : this.store.account(target);
      const proxy = normalizeProxy(input.proxy, oldContext?.proxy || (previous ? this.store.credentials(previous).proxy : undefined));
      const signature = providerSignature(provider);
      const requestHash = manualRequestHash({ provider: input.provider, method: 'manual', name: input.name || '',
        target_account_id: target, interval_hours: input.interval_hours, proxy, provider_signature: signature }, payload);
      if (existing && oldContext) {
        if (!oldContext.manual_request_hash || !equal(oldContext.manual_request_hash, requestHash)) throw new HttpError(409, '此保存请求已用于其他内容，请重新提交表单。');
        if (!equal(existing.owner_fingerprint, this.security.adminFingerprint()) || !equal(oldContext.provider_signature, signature)) {
          throw new HttpError(409, '管理员或站点设置已变化，请重新填写并保存。');
        }
        if (existing.expires_at <= Date.now() / 1000 || existing.status === 'expired') throw new HttpError(410, '本次保存请求已过期，请重新提交表单。');
        if (existing.status === 'success') {
          if (!existing.account_id || !this.store.account(existing.account_id)) throw new HttpError(409, '先前保存的账号已移除，请重新添加。');
          return Promise.resolve(this.rowView(existing, false));
        }
        if (existing.status === 'cancelled') throw new HttpError(409, '本次保存已取消，请重新提交表单。');
        const running = this.manualTasks.get(requestId);
        if (running) return running;
        if (existing.status === 'verifying') throw new HttpError(409, '账号正在校验，请稍后查看保存结果。');
        if (existing.status === 'failed') {
          if (this.current()) throw new HttpError(409, '已有账号正在校验，请等待完成后再保存。');
          this.store.db.prepare("UPDATE browser_imports SET status='waiting' WHERE id=?").run(requestId);
        }
      } else this.createImport({ ...input, proxy }, { id: requestId, hash: requestHash });
      const task = this.importCredentials(requestId, payload).catch(error => {
        const current = this.row(requestId);
        if (current?.status === 'waiting') this.store.db.prepare("UPDATE browser_imports SET status='failed' WHERE id=?").run(requestId);
        throw error;
      });
      this.manualTasks.set(requestId, task); this.tasks.add(task);
      void task.finally(() => { this.manualTasks.delete(requestId); this.tasks.delete(task); }).catch(() => {});
      return task;
    } catch (error) { return Promise.reject(error); }
  }

  cancel(id: string): boolean {
    const row = this.row(id);
    if (!row || !ACTIVE.has(row.status)) return false;
    this.store.db.prepare("UPDATE browser_imports SET status='cancelled',message=? WHERE id=?").run('已取消连接，未导入的登录状态不会保存。', id);
    this.controllers.get(id)?.abort();
    return true;
  }

  checkTicket(id: string, ticket: unknown): ImportView {
    if (typeof ticket !== 'string' || !IMPORT_TOKEN.test(ticket)) throw new HttpError(401, '连接码无效，请从签到助手重新复制。');
    const row = this.row(id);
    if (!row || !equal(hash(ticket), row.ticket_hash)) throw new HttpError(401, '连接码无效，请从签到助手重新复制。');
    if (!ACTIVE.has(row.status)) throw new HttpError(410, '本次连接已完成、取消或过期，请返回签到助手查看。');
    return this.rowView(row, false, true);
  }

  private checkAccount(id: number | null, provider: string, user: string): void {
    if (id === null) return;
    const account = this.store.account(id);
    if (!account || account.provider !== provider) throw new HttpError(409, '原账号或站点已变化，登录状态未保存。');
    if (['running', 'queued'].includes(account.status) || this.accountBusy(id)) throw new HttpError(409, '原账号正在排队或运行，请结束任务后再连接。');
    const previous = this.store.credentials(account).api_user;
    if (previous !== undefined && String(previous) !== user) throw new HttpError(422, '本次浏览器身份与原账号不同，请单独添加账号。');
  }

  importCredentials(id: string, data: unknown, ticket?: string): Promise<ImportView> {
    if (this.stopping) return Promise.reject(new HttpError(409, '服务正在停止，请稍后重新导入。'));
    const task = this.executeImport(id, data, ticket);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => {});
    return task;
  }

  private async executeImport(id: string, data: unknown, ticket?: string): Promise<ImportView> {
    if (ticket !== undefined) this.checkTicket(id, ticket);
    const row = this.row(id);
    if (!row) throw new HttpError(404, '连接会话不存在。');
    if (row.status === 'success' && ticket === undefined) return this.rowView(row);
    if (row.status !== 'waiting') throw new HttpError(409, '连接正在校验或已结束，请查询当前进度。');
    if (row.attempts >= 20) throw new HttpError(429, '本次连接校验次数过多，请取消后重新开始。');
    const payload = parseImportPayload(data), context = this.context(row), provider = this.providers[context.provider];
    if (context.manual_request_hash && !equal(context.manual_request_hash, manualRequestHash(context, payload))) throw new HttpError(409, '本次保存内容已变化，请重新提交表单。');
    const target = context.target_account_id;
    this.checkAccount(target, provider.name, payload.api_user);
    payload.site_cookies = normalizeImportCookies(payload.site_cookies, { host: new URL(provider.domain).hostname, names: new Set(provider.waf_cookie_names) });
    if (payload.oauth_cookies.length && (provider.name !== 'agentrouter' || !['github', 'linuxdo'].includes(context.method))) throw new HttpError(422, '当前站点或登录方式不需要上游 Cookie，请只导入站点登录状态。');
    payload.oauth_cookies = normalizeImportCookies(payload.oauth_cookies, { roots: context.method === 'github' ? ['github.com'] : context.method === 'linuxdo' ? ['linux.do'] : [] });
    if (payload.refresh_token && !isSub2API(provider)) throw new HttpError(422, '当前站点不使用 Refresh Token。');
    this.store.db.prepare("UPDATE browser_imports SET status='verifying',attempts=attempts+1,message=? WHERE id=?")
      .run(this.manualOnly ? '正在加密保存手动填写的账号…' : '正在后台只读校验原站点身份和余额…', id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 25_000); timeout.unref();
    try {
      const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new HttpError(409, '校验已取消或超时，登录状态未保存。')), { once: true }));
      // Manual saves never contact the provider. The supplied ID is validated
      // locally and remains unverified until the first scheduled or manual run.
      const profile: Profile = this.manualOnly ? { id: payload.api_user }
        : await Promise.race([this.verify(provider, payload, context.proxy, this.config, controller.signal, this.browserResources), aborted]);
      if (controller.signal.aborted) throw new HttpError(409, '校验已取消或超时，登录状态未保存。');
      if (String(profile.id) !== payload.api_user) throw new HttpError(422, '站点身份与导入用户 ID 不一致，未保存。');
      const current = this.row(id);
      if (!current || current.status !== 'verifying') throw new HttpError(409, '连接已取消或过期，登录状态未保存。');
      this.checkAccount(target, provider.name, payload.api_user);
      const snapshot = this.manualOnly ? null : profileSnapshot(profile, provider);
      const credentials = { session: payload.session, api_user: payload.api_user, site_cookies: payload.site_cookies,
        oauth_cookies: payload.oauth_cookies, oauth_user_agent: payload.oauth_user_agent,
        refresh_token: payload.refresh_token || undefined, proxy: context.proxy };
      const name = (context.name || String(profile.username || '站点账号')).slice(0, 40);
      let message = this.manualOnly ? `已手动保存「${name}」。首次运行时验证登录状态并更新余额。`
        : `已校验并保存「${name}」的原站登录状态。`;
      if (provider.name === 'agentrouter' && !payload.oauth_cookies.length) {
        message += context.method === 'manual' ? ' 当前仅同步余额；需要自动登录签到时请选择站内账号密码方式。'
          : ' 当前可同步余额；后台 OAuth 签到需要额外连接对应上游会话。';
      }
      if (!snapshot && !this.manualOnly) message += ' 本次身份已确认，余额暂未知。';
      this.store.transaction(() => {
        let savedId: number;
        if (target !== null) {
          if (!this.store.applyLogin(target, { ...credentials, provider: provider.name, login_via: context.method,
            name, interval_hours: context.interval_hours, balance: snapshot?.balance, used_quota: snapshot?.used_quota })) {
            throw new HttpError(409, '原账号已被移除，登录状态未保存。');
          }
          savedId = target;
        } else {
          savedId = this.store.addAccount({ name, provider: provider.name, auth_mode: 'session', interval_hours: context.interval_hours,
            enabled: true, login_via: context.method, ...credentials });
          if (snapshot) this.store.patch(savedId, { balance: snapshot.balance, used_quota: snapshot.used_quota, total_quota: snapshot.total, has_snapshot: 1 });
        }
        this.store.patch(savedId, { last_message: message });
        this.store.db.prepare("UPDATE browser_imports SET status='success',account_id=?,message=? WHERE id=?").run(savedId, message, id);
      });
      return this.view(id)!;
    } catch (error) {
      const current = this.row(id);
      if (current?.status === 'verifying') this.store.db.prepare("UPDATE browser_imports SET status='waiting',message=? WHERE id=?")
        .run(error instanceof HttpError ? error.message : '校验未完成，尚未保存。请检查网络后重新导入。', id);
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, '账号校验未完成，尚未保存。请重新导入。');
    } finally { clearTimeout(timeout); this.controllers.delete(id); }
  }

  async close(): Promise<void> {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
    this.controllers.clear();
  }
}
