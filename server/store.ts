/** Persistent accounts, site credentials and run history. */
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Fernet, generateFernetKey } from './fernet.js';
import { isRecord } from './errors.js';
import type { AccountInput, AccountRow, ApplyLoginArgs, Credentials, Provider, ProviderInput, ProviderRecord, RunResult } from './types.js';

export interface PublicAccount extends Omit<AccountRow, 'encrypted' | 'enabled' | 'total_quota' | 'has_snapshot' | 'created_at'> {
  enabled: boolean;
  currency: string;
  proxy: { mode: string; server: string; has_auth: boolean };
}

export interface RunRow {
  id: number;
  account_id: number | null;
  account_name: string;
  provider: string;
  status: string;
  trigger_type: string;
  started_at: string;
  finished_at: string | null;
  before_balance: number | null;
  after_balance: number | null;
  reward: number | null;
  message: string | null;
  duration_ms: number | null;
  currency: string;
}

export interface PublicRun extends RunRow { trigger: string }
export interface SchedulerSettings { scheduler_enabled: boolean; interval_hours: number }
export interface TrendPoint { date: string; reward: number; runs: number }
export interface Dashboard {
  accounts: PublicAccount[];
  runs: PublicRun[];
  settings: SchedulerSettings;
  amounts: Record<string, { balance: number | null; today_reward: number }>;
  trends: Record<string, TrendPoint[]>;
  stats: { balance: number | null; today_reward: number; today_completed: number; total_accounts: number };
  trend: TrendPoint[];
}

const ACCOUNT_FIELDS = new Set(['name', 'provider', 'auth_mode', 'encrypted', 'enabled', 'status', 'last_run', 'next_run',
  'last_message', 'balance', 'used_quota', 'total_quota', 'has_snapshot', 'interval_hours', 'created_at', 'login_via']);
const SECRET_FIELDS = ['email', 'password', 'session', 'api_user', 'refresh_token', 'oauth_cookies', 'site_cookies', 'oauth_user_agent', 'proxy'] as const;
const DAY_MS = 86_400_000;

export function iso(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

/** Round the actual IEEE-754 value with Python's round(value, 2) ties-to-even. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) throw new Error('额度数据格式无效。');
  if (value === 0 || Math.abs(value) >= 1e16) return value;
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(Math.abs(value));
  const bits = bytes.readBigUInt64BE();
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n);
  const shift = (exponent ? exponent - 1023 : -1022) - 52;
  const numerator = mantissa * 100n;
  let rounded: bigint;
  if (shift >= 0) rounded = numerator << BigInt(shift);
  else {
    const denominator = 1n << BigInt(-shift);
    rounded = numerator / denominator;
    const twiceRemainder = 2n * (numerator % denominator);
    if (twiceRemainder > denominator || (twiceRemainder === denominator && rounded % 2n === 1n)) rounded++;
  }
  return (value < 0 ? -Number(rounded) : Number(rounded)) / 100;
}

function sqlValue(value: unknown): SQLInputValue {
  if (value === null) return null;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error('账号状态字段无效。');
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function nextRun(hours: number, now: Date = new Date()): string {
  return iso(new Date(now.getTime() + hours * 3_600_000));
}

function moneyOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('额度数据格式无效。');
  return value;
}

function group(row: { currency: string; provider: string }): string {
  return row.currency === 'credits' ? 'credits:' + row.provider : row.currency;
}

/** Old credential files can contain proxy credentials inside the URL. */
function publicProxySnapshot(value: unknown): PublicAccount['proxy'] {
  if (!isRecord(value) || !['default', 'direct', 'custom'].includes(String(value.mode))) {
    return { mode: 'default', server: '', has_auth: false };
  }
  const mode = String(value.mode);
  if (mode !== 'custom') return { mode, server: '', has_auth: false };
  const result = { mode, server: '', has_auth: value.authenticate === true };
  if (typeof value.server !== 'string' || value.server.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value.server)) return result;
  const match = /^(https?|socks5):\/\/([^/?#]+)\/?$/i.exec(value.server);
  if (!match) return result;
  try {
    const url = new URL(value.server);
    if (!url.hostname || !['http:', 'https:', 'socks5:'].includes(url.protocol)) return result;
    const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
    // Keep explicit default ports: validated configurations preserve them too.
    const port = authority.match(/(?:\]|[^:]):([0-9]+)$/)?.[1];
    result.server = `${url.protocol}//${url.hostname}${port ? ':' + Number(port) : ''}`;
    result.has_auth ||= Boolean(url.username || url.password);
  } catch { /* Invalid legacy addresses are never reflected into the UI. */ }
  return result;
}

export class Store {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly keyPath: string;
  readonly providers: Record<string, Provider>;
  readonly timezone: string;
  private readonly fernet: Fernet;
  private readonly dateFormatter: Intl.DateTimeFormat;
  private savepointSequence = 0;
  private closed = false;

  constructor(options: { dataDir: string; providers: Record<string, Provider>; timezone: string }) {
    this.providers = options.providers;
    this.timezone = options.timezone;
    try {
      this.dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: options.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      throw new Error('CHECKIN_TIMEZONE 必须是有效的 IANA 时区，例如 Asia/Shanghai。');
    }
    const directory = path.resolve(options.dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
    this.dbPath = path.join(directory, 'checkin-assistant.db');
    this.keyPath = path.join(directory, 'secret.key');
    if (!existsSync(this.keyPath)) {
      if (existsSync(this.dbPath) && statSync(this.dbPath).size > 0) {
        throw new Error('已有数据库缺少 secret.key，请恢复原加密密钥后启动。');
      }
      let descriptor: number | undefined;
      try {
        descriptor = openSync(this.keyPath, 'wx', 0o600);
        writeFileSync(descriptor, generateFernetKey(), { encoding: 'utf8' });
      } catch (error) {
        if (!isRecord(error) || error.code !== 'EEXIST') throw error;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    if (process.platform !== 'win32' && (statSync(this.keyPath).mode & 0o077)) {
      throw new Error('数据目录的密钥权限过宽，请将该文件权限设为 600。');
    }
    this.fernet = new Fernet(readFileSync(this.keyPath));
    this.db = new DatabaseSync(this.dbPath);
    try {
      if (process.platform !== 'win32') chmodSync(this.dbPath, 0o600);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction<T>(action: () => T): T {
    const outermost = !this.db.isTransaction;
    const savepoint = 'checkin_' + (++this.savepointSequence);
    this.db.exec(outermost ? 'BEGIN IMMEDIATE' : 'SAVEPOINT ' + savepoint);
    try {
      const result = action();
      if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        throw new Error('数据库事务不能跨越异步操作。');
      }
      this.db.exec(outermost ? 'COMMIT' : 'RELEASE SAVEPOINT ' + savepoint);
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        if (outermost) this.db.exec('ROLLBACK');
        else this.db.exec('ROLLBACK TO SAVEPOINT ' + savepoint + '; RELEASE SAVEPOINT ' + savepoint);
      }
      throw error;
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
          provider TEXT NOT NULL, auth_mode TEXT NOT NULL,
          encrypted TEXT NOT NULL, enabled INTEGER DEFAULT 1,
          status TEXT DEFAULT 'idle', last_run TEXT, next_run TEXT,
          last_message TEXT DEFAULT '等待首次签到', balance REAL, used_quota REAL,
          total_quota REAL, has_snapshot INTEGER DEFAULT 0,
          interval_hours INTEGER DEFAULT 6, created_at TEXT NOT NULL, login_via TEXT
        );
        CREATE TABLE IF NOT EXISTS runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER,
          account_name TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
          trigger_type TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
          before_balance REAL, after_balance REAL, reward REAL,
          message TEXT, duration_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS custom_providers (
          id TEXT PRIMARY KEY, config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
        );
      `);
      const columns = this.db.prepare('PRAGMA table_info(accounts)').all();
      if (!columns.some(column => column.name === 'login_via')) this.db.exec('ALTER TABLE accounts ADD COLUMN login_via TEXT');
      const runColumns = this.db.prepare('PRAGMA table_info(runs)').all();
      if (!runColumns.some(column => column.name === 'currency')) this.db.exec("ALTER TABLE runs ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS runs_started_at_jd ON runs(julianday(started_at));
        CREATE INDEX IF NOT EXISTS runs_provider ON runs(provider);
      `);
      this.db.prepare("UPDATE accounts SET status='idle',last_message=? WHERE status='vip_required'")
        .run('已恢复普通签到，等待下一次执行。');
      this.db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)')
        .run('scheduler', JSON.stringify({ enabled: true, interval_hours: 6 }));
    });
  }

  close(): void {
    if (!this.closed) { this.db.close(); this.closed = true; }
  }

  encryptCredentials(data: unknown): string {
    if (!isRecord(data)) throw new Error('凭据内容格式无效。');
    try { return this.fernet.encrypt(JSON.stringify(data)); }
    catch { throw new Error('凭据内容无法加密。'); }
  }

  decryptCredentials<T = Credentials>(encrypted: string): T {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.fernet.decrypt(encrypted));
      const data: unknown = JSON.parse(text);
      if (!isRecord(data)) throw new Error();
      return data as T;
    } catch { throw new Error('凭据无法解密，请确认原 secret.key 与数据库放在一起。'); }
  }

  credentials(row: Pick<AccountRow, 'encrypted'>): Credentials {
    return this.decryptCredentials(row.encrypted);
  }

  accounts(enabledOnly = false): AccountRow[] {
    return this.db.prepare('SELECT * FROM accounts' + (enabledOnly ? ' WHERE enabled=1' : '') + ' ORDER BY id')
      .all().map(row => ({ ...row }) as unknown as AccountRow);
  }

  account(id: number): AccountRow | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
    return row ? ({ ...row }) as unknown as AccountRow : undefined;
  }

  publicAccount(row: AccountRow): PublicAccount {
    const proxy = this.credentials(row).proxy;
    return { id: row.id, name: row.name, provider: row.provider, auth_mode: row.auth_mode,
      enabled: Boolean(row.enabled), status: row.status, last_run: row.last_run, next_run: row.next_run,
      last_message: row.last_message, balance: row.balance, used_quota: row.used_quota,
      interval_hours: row.interval_hours, login_via: row.login_via ?? null,
      proxy: publicProxySnapshot(proxy),
      currency: this.providers[row.provider]?.currency ?? 'USD' };
  }

  addAccount(data: AccountInput): number {
    const credentials = Object.fromEntries(SECRET_FIELDS.filter(key => truthy(data[key])).map(key => [key, data[key]]));
    const now = new Date();
    const result = this.db.prepare('INSERT INTO accounts(name,provider,auth_mode,encrypted,enabled,interval_hours,next_run,created_at,login_via) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(data.name, data.provider, data.auth_mode, this.encryptCredentials(credentials), Number(data.enabled ?? true),
        data.interval_hours, nextRun(data.interval_hours, now), iso(now), data.login_via ?? null);
    const id = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(id)) throw new Error('账号数量超出可用范围。');
    return id;
  }

  patch(id: number, fields: Partial<Omit<AccountRow, 'id'>>): void {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    if (entries.some(([key]) => !ACCOUNT_FIELDS.has(key))) throw new Error('账号状态字段无效。');
    this.db.prepare('UPDATE accounts SET ' + entries.map(([key]) => key + '=?').join(',') + ' WHERE id=?')
      .run(...entries.map(([, value]) => sqlValue(value)), id);
  }

  updateAccount(id: number, data: AccountInput): boolean {
    return this.transaction(() => {
      const row = this.account(id);
      if (!row) return false;
      if (data.provider !== row.provider) throw new Error('已有账号不能更改平台，请单独添加账号');
      if (row.status === 'queued' || row.status === 'running') throw new Error('任务运行中，暂不能编辑');
      let old = this.credentials(row);
      const proxy = data.proxy ?? old.proxy;
      for (const key of ['email', 'password', 'session', 'api_user'] as const) if (data[key]) old[key] = data[key];
      if (data.auth_mode === 'session' && data.replace_credentials !== false) old = { session: old.session, api_user: old.api_user };
      else if (data.auth_mode === 'password') old = { ...(old.email ? { email: old.email } : {}), ...(old.password ? { password: old.password } : {}) };
      if (proxy !== undefined) old.proxy = proxy;
      this.patch(id, { name: data.name, auth_mode: data.auth_mode, encrypted: this.encryptCredentials(old),
        enabled: Number(data.enabled), interval_hours: data.interval_hours, next_run: nextRun(data.interval_hours),
        login_via: data.auth_mode === 'password' ? null : (data.login_via ?? row.login_via) });
      return true;
    });
  }

  applyLogin(id: number, args: ApplyLoginArgs): boolean {
    return this.transaction(() => {
      const row = this.account(id);
      if (!row) return false;
      if (row.provider !== args.provider) throw new Error('重新授权的平台与原账号不一致，登录状态未保存。');
      if (row.status === 'queued' || row.status === 'running') throw new Error('账号正在排队或运行，登录状态未保存。');
      const previous = this.credentials(row);
      if (previous.api_user !== undefined && String(previous.api_user) !== String(args.api_user)) {
        throw new Error('本次授权身份与原账号不同，请单独添加账号，登录状态未保存。');
      }
      const credentials: Credentials = { session: args.session, api_user: String(args.api_user), oauth_cookies: args.oauth_cookies ?? [] };
      const proxy = args.proxy ?? previous.proxy;
      if (proxy !== undefined) credentials.proxy = proxy;
      if (args.site_cookies?.length) credentials.site_cookies = args.site_cookies;
      if (args.refresh_token) credentials.refresh_token = args.refresh_token;
      if (args.oauth_user_agent) credentials.oauth_user_agent = args.oauth_user_agent;
      const updates: Partial<Omit<AccountRow, 'id'>> = { auth_mode: 'session', encrypted: this.encryptCredentials(credentials),
        login_via: args.login_via, status: 'idle', last_message: '登录状态已更新' };
      if (args.name) updates.name = Array.from(args.name).slice(0, 40).join('');
      if (args.interval_hours !== undefined) {
        updates.interval_hours = args.interval_hours;
        updates.next_run = nextRun(args.interval_hours);
      }
      if (args.balance !== undefined && args.balance !== null) {
        updates.balance = moneyOrNull(args.balance);
        updates.used_quota = moneyOrNull(args.used_quota);
        updates.total_quota = args.used_quota === undefined || args.used_quota === null ? null : roundMoney(args.balance + args.used_quota);
        updates.has_snapshot = 1;
      }
      this.patch(id, updates);
      return true;
    });
  }

  deleteAccount(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM accounts WHERE id=? AND status NOT IN ('running','queued')").run(id).changes) > 0;
  }

  beginRun(row: AccountRow, trigger: string): number {
    return this.transaction(() => {
      this.patch(row.id, { status: 'running', last_message: '正在验证账号并执行签到…' });
      return Number(this.db.prepare('INSERT INTO runs(account_id,account_name,provider,status,trigger_type,started_at,currency) VALUES(?,?,?,?,?,?,?)')
        .run(row.id, row.name, row.provider, 'running', trigger, iso(), this.providers[row.provider]?.currency ?? 'USD').lastInsertRowid);
    });
  }

  finishRun(runId: number, accountId: number, result: RunResult, _trigger?: string): void {
    this.transaction(() => {
      const now = new Date();
      this.db.prepare('UPDATE runs SET status=?,finished_at=?,before_balance=?,after_balance=?,reward=?,message=?,duration_ms=? WHERE id=?')
        .run(result.status, iso(now), moneyOrNull(result.before_balance), moneyOrNull(result.after_balance),
          moneyOrNull(result.reward), result.message, result.duration_ms ?? 0, runId);
      const updates: Partial<Omit<AccountRow, 'id'>> = { status: result.status, last_run: iso(now),
        last_message: result.message, next_run: nextRun(this.account(accountId)?.interval_hours ?? 6, now) };
      if (result.after_balance !== undefined && result.after_balance !== null) {
        updates.balance = moneyOrNull(result.after_balance);
        updates.used_quota = moneyOrNull(result.used_quota);
        updates.total_quota = moneyOrNull(result.total_quota);
        updates.has_snapshot = 1;
      }
      this.patch(accountId, updates);
    });
  }

  runs(limit = 100): PublicRun[] {
    if (!Number.isSafeInteger(limit) || limit < -1) throw new Error('日志数量无效。');
    return this.db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit).map(raw => {
      const row = { ...raw } as unknown as RunRow;
      return { ...row, status: row.status === 'vip_required' ? 'not_run' : row.status, trigger: row.trigger_type };
    });
  }

  providerConfigs(): ProviderRecord[] {
    return this.db.prepare('SELECT * FROM custom_providers ORDER BY rowid').all().map(row => ({
      id: String(row.id), config: JSON.parse(String(row.config)) as ProviderInput, active: Boolean(row.active) }));
  }

  saveProvider(id: string, config: ProviderInput, options: { active?: boolean } | boolean = {}): void {
    const active = typeof options === 'boolean' ? options : options.active ?? true;
    this.db.prepare('INSERT INTO custom_providers(id,config,active) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,active=excluded.active')
      .run(id, JSON.stringify(config), Number(active));
  }

  settings(): SchedulerSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key='scheduler'").get();
    const settings = JSON.parse(String(row?.value)) as { enabled: boolean; interval_hours: number };
    return { scheduler_enabled: settings.enabled, interval_hours: settings.interval_hours };
  }

  updateSettings(enabled: boolean, hours: number): void {
    if (typeof enabled !== 'boolean' || !Number.isSafeInteger(hours) || hours < 1 || hours > 168) throw new Error('调度设置无效。');
    this.transaction(() => {
      this.db.prepare("UPDATE settings SET value=? WHERE key='scheduler'").run(JSON.stringify({ enabled, interval_hours: hours }));
      this.db.prepare('UPDATE accounts SET interval_hours=?,next_run=?').run(hours, nextRun(hours));
    });
  }

  recoverInterrupted(): number {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT id,account_id FROM runs WHERE status='running'").all();
      const now = new Date();
      for (const run of interrupted) {
        this.db.prepare("UPDATE runs SET status='interrupted',finished_at=?,message='程序退出，任务未完成。' WHERE id=?").run(iso(now), run.id);
        const account = typeof run.account_id === 'number' ? this.account(run.account_id) : undefined;
        if (account) this.patch(account.id, { status: 'interrupted', last_message: '上次任务被中断，等待下次调度。', next_run: nextRun(account.interval_hours, now) });
      }
      const waiting = this.db.prepare("SELECT id FROM accounts WHERE status IN ('queued','running')").all();
      for (const row of waiting) this.patch(Number(row.id), { status: 'idle', next_run: iso(now), last_message: '上次任务尚未开始，已恢复等待执行。' });
      return interrupted.length + waiting.length;
    });
  }

  private localDate(value: string | Date): string {
    const parts = this.dateFormatter.formatToParts(typeof value === 'string' ? new Date(value) : value);
    let year = '', month = '', day = '';
    for (const part of parts) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
    }
    return year + '-' + month + '-' + day;
  }

  dashboard(): Dashboard {
    const accounts = this.accounts().map(row => this.publicAccount(row));
    const runs = this.runs();
    const now = new Date();
    const today = this.localDate(now);
    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(today + 'T00:00:00Z');
      day.setUTCDate(day.getUTCDate() - 6 + index);
      return day.toISOString().slice(0, 10);
    });
    const calendar = new Set(days), currencies = new Set(['USD', ...runs.map(group)]);
    const balances = new Map<string, number>();
    for (const account of accounts) {
      const currency = group(account);
      currencies.add(currency);
      if (account.balance === null) continue;
      balances.set(currency, (balances.get(currency) ?? 0) + account.balance);
    }
    const daily = new Map<string, Map<string, { reward: number; runs: number }>>();
    const totals = new Map<string, { reward: number; runs: number }>();
    const localDates = new Map<string, string>(), completed = new Set<number>();
    // Offset timestamps remain comparable through julianday. Force the range
    // index instead of a full id scan, then retain descending-id sum order.
    const history = this.db.prepare(`
      SELECT account_id,provider,status,started_at,reward,currency FROM runs INDEXED BY runs_started_at_jd
      WHERE julianday(started_at)>=julianday(?) ORDER BY id DESC
    `).iterate(iso(new Date(now.getTime() - 8 * DAY_MS)));
    for (const raw of history) {
      const row = raw as unknown as Pick<RunRow, 'account_id' | 'provider' | 'status' | 'started_at' | 'reward' | 'currency'>;
      const currency = group(row);
      currencies.add(currency);
      let day = localDates.get(row.started_at);
      if (day === undefined) { day = this.localDate(row.started_at); localDates.set(row.started_at, day); }
      if (!calendar.has(day)) continue;
      let bucket = daily.get(currency);
      if (!bucket) { bucket = new Map(); daily.set(currency, bucket); }
      let point = bucket.get(day);
      if (!point) { point = { reward: 0, runs: 0 }; bucket.set(day, point); }
      point.reward += row.reward ?? 0;
      point.runs++;
      let total = totals.get(day);
      if (!total) { total = { reward: 0, runs: 0 }; totals.set(day, total); }
      total.reward += row.currency === 'USD' ? row.reward ?? 0 : 0;
      total.runs++;
      if (day === today && row.account_id !== null && ['success', 'already_checked', 'synced'].includes(row.status)) completed.add(row.account_id);
    }
    const amounts: Dashboard['amounts'] = {};
    const trends: Dashboard['trends'] = {};
    for (const currency of [...currencies].sort()) {
      const balance = balances.get(currency), bucket = daily.get(currency);
      amounts[currency] = { balance: balance === undefined ? null : roundMoney(balance),
        today_reward: roundMoney(bucket?.get(today)?.reward ?? 0) };
      trends[currency] = days.map(day => {
        const point = bucket?.get(day);
        return { date: day.slice(5), reward: roundMoney(point?.reward ?? 0), runs: point?.runs ?? 0 };
      });
    }
    return { accounts, runs, settings: this.settings(), amounts, trends,
      stats: { balance: amounts.USD.balance,
        today_reward: amounts.USD.today_reward,
        today_completed: completed.size,
        total_accounts: accounts.length },
      trend: days.map(day => {
        const point = totals.get(day);
        return { date: day.slice(5), reward: roundMoney(point?.reward ?? 0), runs: point?.runs ?? 0 };
      }) };
  }
}
