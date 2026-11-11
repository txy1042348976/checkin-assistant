import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError, boundedString, isRecord } from './errors.js';
import { normalizeImportCookies, parseImportPayload } from './imports.js';
import { isSub2API } from './protocols.js';
import { BUILTIN_IDS, parseProviderInput, providerFromConfig } from './providers.js';
import { normalizeProxy } from './proxy.js';
import type { Store } from './store.js';
import type { AccountRow, AuthMode, CookieData, Credentials, Provider, ProviderInput, ProxyConfig } from './types.js';

export const ACCOUNT_BACKUP_FORMAT = 'checkin-assistant-accounts';
export const ENCRYPTED_ACCOUNT_BACKUP_FORMAT = 'checkin-assistant-accounts-encrypted';
export const MAX_ACCOUNT_TRANSFER_BYTES = 8 * 1024 * 1024;
export const MAX_ACCOUNT_TRANSFER_REQUEST_BYTES = MAX_ACCOUNT_TRANSFER_BYTES + 16 * 1024;
export const MAX_TRANSFER_ACCOUNTS = 500;
export const ACCOUNT_TRANSFER_PATHS = new Set(['/api/accounts/export', '/api/accounts/backup/preview', '/api/accounts/backup/import']);

const VERSION = 1;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 } as const;
const AAD = Buffer.from('checkin-assistant-accounts-encrypted:1:aes-256-gcm:scrypt:32768:8:1', 'utf8');
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ACCOUNT_KEYS = new Set(['name', 'provider', 'auth_mode', 'enabled', 'interval_hours', 'login_via', 'credentials']);
const CREDENTIAL_KEYS = new Set(['email', 'password', 'session', 'api_user', 'refresh_token', 'proxy', 'site_cookies', 'oauth_cookies', 'oauth_user_agent']);
const PROVIDER_KEYS = new Set(['name', 'domain', 'template', 'login_path', 'sign_in_path', 'user_info_path', 'login_api_path', 'api_user_key', 'quota_per_unit', 'currency']);
const COOKIE_KEYS = new Set(['name', 'value', 'domain', 'path', 'expires', 'expirationDate', 'httpOnly', 'secure', 'sameSite']);
const PROXY_KEYS = new Set(['mode', 'server', 'authenticate', 'username', 'password']);
const LOGIN_VIA = new Set(['github', 'linuxdo', 'manual', 'cookie', 'password']);
let activeKdfs = 0;

export interface PortableAccount {
  name: string;
  provider: string;
  auth_mode: AuthMode;
  enabled: boolean;
  interval_hours: number;
  login_via?: string | null;
  credentials: Credentials;
}

export interface PortableAccountBackup {
  format: typeof ACCOUNT_BACKUP_FORMAT;
  version: 1;
  exported_at: string;
  accounts: PortableAccount[];
  providers: { id: string; config: ProviderInput; active: boolean }[];
}

export interface EncryptedAccountBackup {
  format: typeof ENCRYPTED_ACCOUNT_BACKUP_FORMAT;
  version: 1;
  kdf: { name: 'scrypt'; N: 32768; r: 8; p: 1; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string };
  data: string;
}

export interface AccountTransferPreview {
  account_count: number;
  new_count: number;
  duplicate_count: number;
  error_count: number;
  providers_to_add: { name: string; domain: string }[];
  rows: { index: number; name: string; provider: string; provider_name: string; auth_mode: AuthMode | '';
    status: 'new' | 'duplicate' | 'invalid'; message: string }[];
  can_import: boolean;
}

export interface AccountTransferResult {
  imported: number;
  skipped: number;
  providers_imported: number;
  account_ids: number[];
  replayed?: boolean;
}

interface RawBackup {
  exported_at: string;
  accounts: unknown[];
  providers: unknown[];
}

interface ProviderResolution {
  target?: Provider;
  added?: { id: string; config: ProviderInput; active: boolean; provider: Provider };
  error?: string;
}

interface PlannedAccount {
  entry: PortableAccount;
  target: Provider;
  duplicate: boolean;
}

interface Plan {
  preview: AccountTransferPreview;
  accounts: PlannedAccount[];
  providers: NonNullable<ProviderResolution['added']>[];
}

function invalid(message = '备份文件格式无效或包含不支持的字段。'): never {
  throw new HttpError(422, message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function object(value: unknown, allowed: Set<string>, required: string[] = []): Record<string, unknown> {
  if (!plainRecord(value) || Object.keys(value).some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value) || RESERVED_IDS.has(value)) invalid('站点编号格式无效。');
  return value;
}

function safeReference(value: unknown): string {
  try { return reference(value); } catch { return ''; }
}

function safeName(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 40 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim() : fallback;
}

function serializeFile(file: unknown): string {
  if (!plainRecord(file)) invalid();
  let serialized: string;
  try { serialized = JSON.stringify(file); } catch { return invalid(); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ACCOUNT_TRANSFER_BYTES) throw new HttpError(413, '账号备份文件不能超过 8 MiB。');
  return serialized;
}

function backupPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 1024) invalid('备份密码需要 8 至 1024 个字符。');
  return value;
}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (activeKdfs >= 2) throw new HttpError(429, '其他备份正在加密或解密，请稍后重试。');
  activeKdfs++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 }, (error, key) => {
        if (error) reject(new HttpError(503, '暂时无法处理加密备份，请稍后重试。'));
        else resolve(key);
      });
    });
  } finally { activeKdfs--; }
}

function base64(value: unknown, bytes?: number): Buffer {
  if (typeof value !== 'string' || !value || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) invalid('加密备份格式无效。');
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (bytes !== undefined && result.length !== bytes)) invalid('加密备份格式无效。');
  return result;
}

function parsePlainBackup(file: unknown): RawBackup {
  const body = object(file, new Set(['format', 'version', 'exported_at', 'accounts', 'providers']), ['format', 'version', 'exported_at', 'accounts', 'providers']);
  if (body.format !== ACCOUNT_BACKUP_FORMAT || body.version !== VERSION) invalid('备份文件格式或版本不受支持。');
  if (typeof body.exported_at !== 'string' || body.exported_at.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(body.exported_at)
    || !Number.isFinite(Date.parse(body.exported_at))) invalid('备份导出时间格式无效。');
  if (!Array.isArray(body.accounts) || !Array.isArray(body.providers)) invalid();
  if (body.accounts.length > MAX_TRANSFER_ACCOUNTS || body.providers.length > MAX_TRANSFER_ACCOUNTS) invalid('一次最多导入或导出 500 个账号。');
  return { exported_at: body.exported_at, accounts: body.accounts, providers: body.providers };
}

async function decodeFile(file: unknown, password: unknown): Promise<RawBackup> {
  serializeFile(file);
  if (!plainRecord(file)) invalid();
  if (file.format === ACCOUNT_BACKUP_FORMAT) {
    if (password !== undefined && (typeof password !== 'string' || password.length > 1024)) invalid('备份密码格式无效。');
    return parsePlainBackup(file);
  }
  const envelope = object(file, new Set(['format', 'version', 'kdf', 'cipher', 'data']), ['format', 'version', 'kdf', 'cipher', 'data']);
  if (envelope.format !== ENCRYPTED_ACCOUNT_BACKUP_FORMAT || envelope.version !== VERSION) invalid('备份文件格式或版本不受支持。');
  const kdf = object(envelope.kdf, new Set(['name', 'N', 'r', 'p', 'salt']), ['name', 'N', 'r', 'p', 'salt']);
  const cipher = object(envelope.cipher, new Set(['name', 'iv', 'tag']), ['name', 'iv', 'tag']);
  if (kdf.name !== KDF.name || kdf.N !== KDF.N || kdf.r !== KDF.r || kdf.p !== KDF.p || cipher.name !== 'aes-256-gcm') invalid('加密备份使用了不支持的加密参数。');
  const salt = base64(kdf.salt, 16), iv = base64(cipher.iv, 12), tag = base64(cipher.tag, 16), data = base64(envelope.data);
  const key = await deriveKey(backupPassword(password), salt);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    if (plaintext.length > MAX_ACCOUNT_TRANSFER_BYTES) throw new Error();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    return parsePlainBackup(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, '备份密码不正确或文件已损坏。');
  } finally { key.fill(0); plaintext?.fill(0); }
}

function userId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) invalid('本站用户 ID 格式无效。');
    return String(value);
  }
  if (typeof value !== 'string' || !/^[0-9]{1,100}$/.test(value) || BigInt(value) <= 0n) invalid('本站用户 ID 格式无效。');
  return BigInt(value).toString();
}

function cookieArray(value: unknown, limit: number): CookieData[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit) invalid('Cookie 数据格式或数量无效。');
  for (const raw of value) {
    const cookie = object(raw, COOKIE_KEYS, ['name', 'value', 'domain', 'path']);
    if (cookie.expires !== undefined && cookie.expirationDate !== undefined && cookie.expires !== cookie.expirationDate) invalid('Cookie 有效期格式无效。');
    const expiry = cookie.expires ?? cookie.expirationDate;
    if (expiry !== undefined && (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry < -1 || expiry > 253402300799)) invalid('Cookie 有效期格式无效。');
  }
  return value as CookieData[];
}

function transferProxy(value: unknown): ProxyConfig {
  const proxy = object(value, PROXY_KEYS, ['mode']);
  if (!['default', 'direct', 'custom'].includes(String(proxy.mode))) invalid('代理配置格式无效。');
  if (proxy.server !== undefined && (typeof proxy.server !== 'string' || proxy.server.length > 2048)) invalid('代理地址格式无效。');
  if (proxy.mode !== 'custom' || typeof proxy.server !== 'string') return normalizeProxy(proxy);
  let url: URL;
  try { url = new URL(proxy.server); } catch { return normalizeProxy(proxy); }
  if (!url.username && !url.password) return normalizeProxy(proxy);
  // Older desktop records included Basic credentials in the proxy authority.
  const match = /^(https?|socks5):\/\/([^/?#]+)\/?$/i.exec(proxy.server);
  if (!match) invalid('代理地址格式无效。');
  let username: string, password: string;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { return invalid('代理认证信息格式无效。'); }
  if ((proxy.username !== undefined && proxy.username !== username) || (proxy.password !== undefined && proxy.password !== password)) invalid('代理认证信息存在冲突。');
  const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
  return normalizeProxy({ ...proxy, server: `${url.protocol}//${authority}`, authenticate: true, username, password });
}

function credentialData(value: unknown, mode: AuthMode, provider: Provider, loginVia: string | null): Credentials {
  const body = object(value, CREDENTIAL_KEYS);
  const result: Credentials = {};
  for (const [key, max, trim] of [['email', 200, true], ['password', 1024, false]] as const) {
    if (body[key] !== undefined && body[key] !== null) result[key] = boundedString(body[key], 1, max, trim);
  }
  const apiUser = userId(body.api_user), hasSession = body.session !== undefined && body.session !== null;
  if ((mode === 'password' && (!result.email || !result.password)) || (mode === 'session' && (!hasSession || !apiUser))
    || (hasSession && !apiUser)) invalid('账号缺少对应认证方式所需的凭据。');
  const payload = parseImportPayload({ session: hasSession ? body.session : 'account-transfer-validation', api_user: apiUser ?? '1',
    refresh_token: body.refresh_token, oauth_user_agent: body.oauth_user_agent,
    site_cookies: cookieArray(body.site_cookies, 30), oauth_cookies: cookieArray(body.oauth_cookies, 80) });
  if (hasSession) result.session = payload.session;
  if (apiUser) result.api_user = payload.api_user;
  if (payload.refresh_token) {
    if (!isSub2API(provider)) invalid('当前站点不支持本站刷新 Token。');
    result.refresh_token = payload.refresh_token;
  }
  const siteCookies = normalizeImportCookies(payload.site_cookies, { host: new URL(provider.domain).hostname, names: new Set(provider.waf_cookie_names) });
  if (siteCookies.length) result.site_cookies = siteCookies;
  if (payload.oauth_cookies.length) {
    if (provider.name !== 'agentrouter' || (loginVia !== 'github' && loginVia !== 'linuxdo')) invalid('上游 Cookie 与站点或登录方式不匹配。');
    const roots = loginVia === 'github' ? ['github.com'] : ['linux.do'];
    const cookies = normalizeImportCookies(payload.oauth_cookies, { roots });
    if (cookies.length) result.oauth_cookies = cookies;
  }
  if (payload.oauth_user_agent) result.oauth_user_agent = payload.oauth_user_agent;
  if (body.proxy !== undefined && body.proxy !== null) result.proxy = transferProxy(body.proxy);
  return result;
}

function accountData(value: unknown, provider: Provider): PortableAccount {
  const body = object(value, ACCOUNT_KEYS, ['name', 'provider', 'auth_mode', 'enabled', 'interval_hours', 'credentials']);
  const name = boundedString(body.name, 1, 40);
  if (/[\u0000-\u001f\u007f]/u.test(name)) invalid('账号名称格式无效。');
  const source = reference(body.provider);
  if (body.auth_mode !== 'password' && body.auth_mode !== 'session') invalid('账号认证方式无效。');
  if (!provider.login_methods.includes(body.auth_mode)) invalid('目标站点不支持当前账号认证方式。');
  if (typeof body.enabled !== 'boolean' || typeof body.interval_hours !== 'number' || !Number.isSafeInteger(body.interval_hours)
    || body.interval_hours < 1 || body.interval_hours > 168) invalid('账号启用状态或执行间隔无效。');
  const loginVia = body.login_via ?? null;
  if (loginVia !== null && (typeof loginVia !== 'string' || !LOGIN_VIA.has(loginVia))) invalid('账号原登录方式无效。');
  return { name, provider: source, auth_mode: body.auth_mode, enabled: body.enabled, interval_hours: body.interval_hours,
    login_via: loginVia, credentials: credentialData(body.credentials, body.auth_mode, provider, loginVia) };
}

function identityKeys(provider: string, mode: string, credentials: Credentials): string[] {
  const keys: string[] = [];
  const id = userId(credentials.api_user);
  if (id) keys.push(JSON.stringify([provider, 'user', id]));
  if (mode === 'password' && typeof credentials.email === 'string' && credentials.email.trim()) {
    // Original-site usernames can be case sensitive, including names with @.
    keys.push(JSON.stringify([provider, 'login', credentials.email.trim()]));
  }
  return keys;
}

function loginIdentity(provider: string, mode: string, credentials: Credentials): string | undefined {
  return mode === 'password' && typeof credentials.email === 'string' && credentials.email.trim()
    ? JSON.stringify([provider, 'login', credentials.email.trim()]) : undefined;
}

function configOf(provider: Provider): ProviderInput {
  return { name: provider.display_name, domain: provider.domain, template: provider.template, login_path: provider.login_path,
    sign_in_path: provider.sign_in_path, user_info_path: provider.user_info_path, login_api_path: provider.login_api_path,
    api_user_key: provider.api_user_key, quota_per_unit: provider.quota_per_unit, currency: provider.currency };
}

function sameConfig(left: ProviderInput, right: ProviderInput): boolean {
  return [...PROVIDER_KEYS].filter(key => key !== 'name').every(key => left[key as keyof ProviderInput] === right[key as keyof ProviderInput]);
}

function fingerprint(file: string, restoreEnabled: boolean): string {
  return createHash('sha256').update('account-file-import:1\0').update(file, 'utf8').update('\0').update(restoreEnabled ? '1' : '0').digest('hex');
}

function sameFingerprint(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Portable account files never call an identity endpoint or the check-in engine. */
export class AccountTransfers {
  constructor(private readonly store: Store, private readonly registry: Record<string, Provider>) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS account_file_imports (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
      result TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }

  async exportBackup(value: unknown, authorize: () => void = () => {}): Promise<PortableAccountBackup | EncryptedAccountBackup> {
    authorize();
    const body = object(value, new Set(['account_ids', 'encrypted', 'password']));
    const encrypted = body.encrypted === undefined ? true : body.encrypted;
    if (typeof encrypted !== 'boolean') invalid('备份加密设置格式无效。');
    const password = encrypted ? backupPassword(body.password) : undefined;
    if (!encrypted && body.password !== undefined && body.password !== '') invalid('明文导出不需要备份密码。');
    let ids: number[] | undefined;
    if (body.account_ids !== undefined) {
      if (!Array.isArray(body.account_ids) || body.account_ids.length > MAX_TRANSFER_ACCOUNTS || body.account_ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
        || new Set(body.account_ids).size !== body.account_ids.length) invalid('请选择最多 500 个有效账号。');
      ids = body.account_ids as number[];
    }
    const backup = this.store.transaction((): PortableAccountBackup => {
      const all = this.store.accounts(), selected = ids === undefined ? all : ids.map(id => all.find(row => row.id === id));
      if (selected.some(row => !row)) throw new HttpError(404, '部分所选账号已不存在，请重新选择。');
      if (selected.length > MAX_TRANSFER_ACCOUNTS) invalid('一次最多导入或导出 500 个账号，请分批选择。');
      const configs = new Map(this.store.providerConfigs().map(record => [record.id, record]));
      const referenced = new Set<string>();
      const accounts = (selected as AccountRow[]).map(row => {
        const id = reference(row.provider), provider = Object.hasOwn(this.registry, id) ? this.registry[id] : undefined;
        if (!provider) invalid('部分账号的站点配置不可用，无法生成完整备份。');
        if (provider.custom) referenced.add(id);
        const credentials = Object.fromEntries(Object.entries(this.store.credentials(row)).filter(([key]) => CREDENTIAL_KEYS.has(key)));
        return accountData({ name: row.name, provider: id, auth_mode: row.auth_mode, enabled: Boolean(row.enabled),
          interval_hours: row.interval_hours, login_via: row.login_via, credentials }, provider);
      });
      const providers = [...referenced].map(id => {
        const record = configs.get(id);
        if (!record || BUILTIN_IDS.has(id)) invalid('部分自定义站点缺少配置，无法生成完整备份。');
        const config = parseProviderInput(record.config);
        if (!sameConfig(config, configOf(this.registry[id]))) invalid('部分自定义站点配置已变化，请重试导出。');
        return { id, config, active: record.active };
      });
      return { format: ACCOUNT_BACKUP_FORMAT, version: VERSION, exported_at: new Date().toISOString(), accounts, providers };
    });
    const serialized = serializeFile(backup);
    if (!encrypted) { authorize(); return backup; }
    const salt = randomBytes(16), iv = randomBytes(12), key = await deriveKey(password!, salt);
    try {
      authorize();
      const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
      const result: EncryptedAccountBackup = { format: ENCRYPTED_ACCOUNT_BACKUP_FORMAT, version: VERSION,
        kdf: { ...KDF, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }, data: data.toString('base64') };
      serializeFile(result);
      authorize();
      return result;
    } finally { key.fill(0); }
  }

  async previewBackup(value: unknown, authorize: () => void = () => {}): Promise<AccountTransferPreview> {
    authorize();
    const body = object(value, new Set(['file', 'password']), ['file']);
    const backup = await decodeFile(JSON.parse(serializeFile(body.file)) as unknown, body.password);
    authorize();
    return this.plan(backup).preview;
  }

  async importBackup(value: unknown, authorize: () => void = () => {}): Promise<AccountTransferResult> {
    authorize();
    const body = object(value, new Set(['file', 'password', 'request_id', 'restore_enabled']), ['file', 'request_id']);
    if (typeof body.request_id !== 'string' || !/^[a-f0-9]{32}$/.test(body.request_id)) invalid('导入请求标识无效，请重新选择文件。');
    const restoreEnabled = body.restore_enabled === undefined ? false : body.restore_enabled;
    if (typeof restoreEnabled !== 'boolean') invalid('恢复账号启用状态的设置无效。');
    const serialized = serializeFile(body.file), hash = fingerprint(serialized, restoreEnabled);
    const backup = await decodeFile(JSON.parse(serialized) as unknown, body.password);
    authorize();
    const added: NonNullable<ProviderResolution['added']>[] = [];
    const result = this.store.transaction((): AccountTransferResult => {
      authorize();
      const existing = this.store.db.prepare('SELECT fingerprint,result FROM account_file_imports WHERE request_id=?').get(body.request_id as string);
      if (existing) {
        if (!sameFingerprint(String(existing.fingerprint), hash)) throw new HttpError(409, '此导入请求已用于其他内容，请重新选择文件后导入。');
        const prior = JSON.parse(String(existing.result)) as AccountTransferResult;
        return { imported: prior.imported, skipped: prior.skipped, providers_imported: prior.providers_imported, account_ids: prior.account_ids, replayed: true };
      }
      const plan = this.plan(backup);
      if (plan.preview.error_count) invalid('备份包含无法导入的账号，请先查看预览并修正文件。');
      if (plan.providers.length && !Object.isExtensible(this.registry)) throw new HttpError(409, '站点列表暂时无法更新，请稍后重试。');
      for (const provider of plan.providers) {
        // Append only: do not use the provider-edit UPSERT during a restore.
        this.store.db.prepare('INSERT INTO custom_providers(id,config,active) VALUES(?,?,?)').run(provider.id, JSON.stringify(provider.config), Number(provider.active));
        added.push(provider);
      }
      const accountIds: number[] = [];
      for (const { entry, target, duplicate } of plan.accounts) {
        if (duplicate) continue;
        const enabled = restoreEnabled && entry.enabled && target.active;
        const id = this.store.addAccount({ ...entry.credentials, name: entry.name, provider: target.name,
          auth_mode: entry.auth_mode, login_via: entry.login_via, interval_hours: entry.interval_hours, enabled });
        this.store.patch(id, { status: 'idle', last_run: null, last_message: '从文件导入，尚未校验原站凭据。', balance: null,
          used_quota: null, total_quota: null, has_snapshot: 0, ...(!enabled ? { next_run: null } : {}) });
        accountIds.push(id);
      }
      const result: AccountTransferResult = { imported: accountIds.length, skipped: plan.preview.duplicate_count,
        providers_imported: plan.providers.length, account_ids: accountIds };
      this.store.db.prepare('INSERT INTO account_file_imports(request_id,fingerprint,result,created_at) VALUES(?,?,?,?)')
        .run(body.request_id as string, hash, JSON.stringify(result), new Date().toISOString());
      return result;
    });
    for (const entry of added) this.registry[entry.id] = entry.provider;
    return result;
  }

  private plan(backup: RawBackup): Plan {
    const references = new Set(backup.accounts.flatMap(row => plainRecord(row) && typeof row.provider === 'string' ? [row.provider] : []));
    const resolutions = new Map<string, ProviderResolution>();
    const candidates: NonNullable<ProviderResolution['added']>[] = [];
    const sourceDomains = new Map<string, { config: ProviderInput; active: boolean }>();
    const storedIds = new Set(this.store.providerConfigs().map(record => record.id));
    const freshId = (): string => {
      for (let attempt = 0; attempt < 8; attempt++) {
        const id = 'custom_' + randomUUID().replace(/-/g, '');
        if (!Object.hasOwn(this.registry, id) && !storedIds.has(id) && !candidates.some(item => item.id === id)) return id;
      }
      throw new HttpError(409, '暂时无法创建新的站点编号，请重试。');
    };
    for (const raw of backup.providers) {
      if (!plainRecord(raw) || typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.id)) invalid('备份中的站点配置格式无效。');
      const id = raw.id;
      if (!references.has(id)) invalid('备份包含未关联账号的站点配置。');
      if (resolutions.has(id)) { resolutions.set(id, { error: '备份中的站点编号重复。' }); continue; }
      try {
        reference(id);
        if (BUILTIN_IDS.has(id)) invalid('备份不能覆盖内置站点配置。');
        const record = object(raw, new Set(['id', 'config', 'active']), ['id', 'config', 'active']);
        const config = parseProviderInput(object(record.config, PROVIDER_KEYS, [...PROVIDER_KEYS]));
        if (typeof record.active !== 'boolean') invalid('站点启用状态格式无效。');
        const source = sourceDomains.get(config.domain);
        if (source && (!sameConfig(source.config, config) || source.active !== record.active)) invalid('备份中相同网址的站点配置或启用状态存在冲突。');
        sourceDomains.set(config.domain, { config, active: record.active });
        const domainMatches = Object.values(this.registry).filter(provider => provider.domain === config.domain);
        const activeMatches = domainMatches.filter(provider => provider.active);
        const existing = activeMatches.length ? activeMatches : domainMatches;
        if (existing.some(provider => !provider.custom || !sameConfig(configOf(provider), config))) invalid('相同网址的已有站点配置不兼容，不能替换或覆盖。');
        if (existing.length) {
          const target = existing.find(provider => provider.active) ?? existing[0];
          if (!target.active && record.active) invalid('相同网址的已有站点已停用，请先新增可用站点后重新导入。');
          resolutions.set(id, { target }); continue;
        }
        const planned = candidates.find(item => item.config.domain === config.domain);
        if (planned) {
          if (!sameConfig(planned.config, config)) invalid('备份中相同网址的站点配置存在冲突。');
          resolutions.set(id, { target: planned.provider, added: planned }); continue;
        }
        const targetId = freshId(), provider = providerFromConfig(targetId, config, record.active);
        const added = { id: targetId, config, active: record.active, provider };
        candidates.push(added); resolutions.set(id, { target: provider, added });
      } catch (error) { resolutions.set(id, { error: error instanceof HttpError ? error.message : '站点配置信息无效。' }); }
    }
    const seen = new Set<string>(), knownLoginIds = new Map<string, Set<string>>();
    const remember = (provider: string, mode: string, credentials: Credentials): void => {
      for (const key of identityKeys(provider, mode, credentials)) seen.add(key);
      const login = loginIdentity(provider, mode, credentials), id = userId(credentials.api_user);
      if (login && id) {
        const ids = knownLoginIds.get(login) ?? new Set<string>();
        ids.add(id); knownLoginIds.set(login, ids);
      }
    };
    try {
      for (const row of this.store.accounts()) remember(row.provider, row.auth_mode, this.store.credentials(row));
    } catch { throw new HttpError(409, '已有账号无法读取，暂时不能可靠检查重复，请先检查原数据。'); }
    const accounts: PlannedAccount[] = [], rows: AccountTransferPreview['rows'] = [], usedProviders = new Set<string>();
    for (const [offset, raw] of backup.accounts.entries()) {
      const record = plainRecord(raw) ? raw : {};
      const source = safeReference(record.provider), resolution = resolutions.get(source);
      const builtin = BUILTIN_IDS.has(source) && Object.hasOwn(this.registry, source) && !this.registry[source].custom ? this.registry[source] : undefined;
      const provider = resolution?.target ?? builtin;
      const row: AccountTransferPreview['rows'][number] = { index: offset + 1, name: safeName(record.name, `第 ${offset + 1} 个账号`),
        provider: source, provider_name: provider?.display_name ?? '未知站点', auth_mode: record.auth_mode === 'password' || record.auth_mode === 'session' ? record.auth_mode : '',
        status: 'invalid', message: '账号字段或凭据格式无效。' };
      try {
        if (resolution?.error) invalid(resolution.error);
        if (!provider) invalid('缺少当前账号的完整站点配置，不能确认凭据来源。');
        const entry = accountData(raw, provider), keys = identityKeys(provider.name, entry.auth_mode, entry.credentials);
        const login = loginIdentity(provider.name, entry.auth_mode, entry.credentials), id = userId(entry.credentials.api_user);
        const knownIds = login ? knownLoginIds.get(login) : undefined;
        if (id && knownIds?.size && !knownIds.has(id)) invalid('备份账号的登录名与已知站内用户 ID 不一致。');
        if (id && login && seen.has(login) && seen.has(JSON.stringify([provider.name, 'user', id])) && !knownIds?.has(id)) {
          invalid('多个条目关联同一账号身份，请合并或删除重复条目后重试。');
        }
        const duplicate = keys.some(key => seen.has(key));
        remember(provider.name, entry.auth_mode, entry.credentials);
        row.status = duplicate ? 'duplicate' : 'new';
        row.message = duplicate ? '已有相同站点账号或文件中重复，将跳过。' : '可追加导入，尚未校验原站凭据。';
        accounts.push({ entry, target: provider, duplicate });
        if (!duplicate && resolution?.added) usedProviders.add(resolution.added.id);
      } catch (error) { row.message = error instanceof HttpError ? error.message : '账号字段或凭据格式无效。'; }
      rows.push(row);
    }
    const providers = candidates.filter(item => usedProviders.has(item.id));
    const newCount = rows.filter(row => row.status === 'new').length, duplicateCount = rows.filter(row => row.status === 'duplicate').length,
      errorCount = rows.filter(row => row.status === 'invalid').length;
    return { accounts, providers, preview: { account_count: rows.length, new_count: newCount, duplicate_count: duplicateCount, error_count: errorCount,
      providers_to_add: providers.map(item => ({ name: item.config.name, domain: item.config.domain })), rows, can_import: errorCount === 0 && newCount > 0 } };
  }
}
