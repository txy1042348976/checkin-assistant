export type LoginMethod = 'github' | 'linuxdo' | 'manual';
export type AuthMode = 'password' | 'session';
export type Template = 'newapi' | 'sign_in' | 'balance' | 'sub2api' | 'sub2api_balance';
export type Currency = 'USD' | 'CNY' | 'credits';
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'already_checked' | 'synced' | 'manual_required' | 'failed' | 'interrupted' | 'not_run';

export interface ProxyConfig {
  mode: 'default' | 'direct' | 'custom';
  server?: string;
  authenticate?: boolean;
  username?: string;
  password?: string;
}

export interface CookieData {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface Credentials {
  email?: string;
  password?: string;
  session?: string;
  api_user?: string;
  refresh_token?: string;
  site_cookies?: CookieData[];
  oauth_cookies?: CookieData[];
  oauth_user_agent?: string;
  proxy?: ProxyConfig;
}

export interface ProviderInput {
  name: string;
  domain: string;
  template: Template;
  login_path: string;
  sign_in_path: string | null;
  user_info_path: string;
  login_api_path: string;
  api_user_key: string;
  quota_per_unit: number;
  currency: Currency;
}

export interface Provider extends Omit<ProviderInput, 'name'> {
  name: string;
  display_name: string;
  custom: boolean;
  active: boolean;
  login_methods: string[];
  oauth_availability: string;
  oauth_navigation_paths: string[];
  waf_cookie_names: string[];
  bypass_method: 'waf_cookies' | null;
  use_proxy: boolean;
  persist_profile: boolean;
  logout_path: string | null;
}

export interface ProviderRecord {
  id: string;
  config: ProviderInput;
  active: boolean;
}

export interface AccountRow {
  id: number;
  name: string;
  provider: string;
  auth_mode: AuthMode;
  encrypted: string;
  enabled: number;
  status: RunStatus;
  last_run: string | null;
  next_run: string | null;
  last_message: string;
  balance: number | null;
  used_quota: number | null;
  total_quota: number | null;
  has_snapshot: number;
  interval_hours: number;
  created_at: string;
  login_via: string | null;
}

export interface AccountInput extends Credentials {
  name: string;
  provider: string;
  auth_mode: AuthMode;
  enabled: boolean;
  interval_hours: number;
  login_via?: string | null;
  replace_credentials?: boolean;
}

export interface ApplyLoginArgs extends Credentials {
  session: string;
  api_user: string;
  provider: string;
  login_via: string;
  name?: string;
  interval_hours?: number;
  balance?: number | null;
  used_quota?: number | null;
}

export interface RunResult {
  status: RunStatus;
  message: string;
  before_balance?: number | null;
  after_balance?: number | null;
  reward?: number | null;
  used_quota?: number | null;
  total_quota?: number | null;
  duration_ms?: number;
  _session_update?: Partial<Credentials>;
  _retryable?: boolean;
}

export interface Snapshot {
  balance: number;
  used_quota: number | null;
  total: number | null;
}

export interface Profile extends Record<string, unknown> {
  id: string | number;
  username?: string;
  checked_in?: boolean;
}

export interface AppConfig {
  dataDir: string;
  resourceRoot: string;
  host: string;
  port: number;
  timezone: string;
  publicUrl: string;
  trustedProxies: string[];
  maxConcurrentRuns: number;
  sessionHours: number;
  loginMaxAttempts: number;
  loginWindowSeconds: number;
  loginGlobalMaxAttempts: number;
  adminUser: string;
  adminPassword?: string;
  browserPath?: string;
  browserNoSandbox: boolean;
  lowMemory: boolean;
  defaultProxyUrl?: string;
  schedulerTickMs: number;
  version: string;
  testMode: boolean;
}

export interface ImportPayload {
  session: string;
  api_user: string;
  site_cookies: CookieData[];
  oauth_cookies: CookieData[];
  oauth_user_agent: string;
  refresh_token: string | null;
}

export type ImportStatus = 'waiting' | 'verifying' | 'success' | 'failed' | 'cancelled' | 'expired';
export interface BrowserConnection {
  version: number;
  origin: string;
  id: string;
  ticket: string;
}

export interface ImportView {
  id: string;
  provider: string | Record<string, unknown>;
  method: LoginMethod;
  name: string;
  status: ImportStatus;
  stage: 'user_browser';
  message: string;
  account_id: number | null;
  elapsed: number;
  expires_at: string;
  browser_url: string;
  verification_paused: false;
  verification_auto: false;
  oauth_continue_available: false;
  connection?: BrowserConnection;
}
