import { HttpError, isRecord } from './errors.js';
import type { Provider, ProviderInput, ProviderRecord, Template, Currency } from './types.js';

export const BROWSER_METHODS = ['github', 'linuxdo', 'manual'] as const;
export const CREDENTIAL_METHODS = ['password', 'session'] as const;
export const BUILTIN_IDS = new Set(['anyrouter', 'agentrouter']);
const TEMPLATES = new Set<Template>(['newapi', 'sign_in', 'balance', 'sub2api', 'sub2api_balance']);
const CURRENCIES = new Set<Currency>(['USD', 'CNY', 'credits']);
const INPUT_KEYS = new Set(['name', 'domain', 'template', 'login_path', 'sign_in_path', 'user_info_path', 'login_api_path', 'api_user_key', 'quota_per_unit', 'currency']);
const RESERVED_HEADERS = new Set(['cookie', 'authorization', 'host', 'origin', 'referer', 'content-type', 'content-length', 'connection', 'x-requested-with', 'accept', 'user-agent']);

function invalid(field: string, message: string): never {
  throw new HttpError(422, message, { fields: [field] });
}

export function normalizeProviderDomain(value: unknown): string {
  if (typeof value !== 'string' || value.length > 250) invalid('domain', '请填写 HTTPS 根网址。');
  const source = value.trim();
  if (/[\s\\\u0000-\u001f\u007f]/u.test(source)) invalid('domain', '网址包含无效字符。');
  let url: URL;
  try { url = new URL(source); } catch { return invalid('domain', '请填写有效的 HTTPS 根网址。'); }
  const authority = source.match(/^https:\/\/([^/]+)/i)?.[1] ?? '';
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || !['', '/'].includes(url.pathname)
      || url.search || url.hash || authority.includes('%')) {
    invalid('domain', '请填写 HTTPS 根网址，不含账号、路径、参数或片段。');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.startsWith('.') || !host) invalid('domain', '域名无效。');
  if (url.port && (!/^[0-9]+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) invalid('domain', '端口无效。');
  url.hostname = host;
  return url.origin;
}

export function sameSitePath(value: unknown, field = 'path'): string {
  if (typeof value !== 'string' || value.length > 200) invalid(field, '接口必须是以 / 开头的站内路径。');
  const path = value.trim();
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)) {
    invalid(field, '接口必须是以 / 开头的站内路径，不含参数或跳转地址。');
  }
  return path;
}

export function parseProviderInput(value: unknown): ProviderInput {
  if (!isRecord(value)) throw new HttpError(422, '站点配置信息不完整或格式无效。');
  const unexpected = Object.keys(value).filter(key => !INPUT_KEYS.has(key));
  if (unexpected.length) throw new HttpError(422, '站点配置包含不支持的字段。', { fields: unexpected });
  if (typeof value.name !== 'string' || value.name.trim().length < 1 || value.name.trim().length > 40 || /[\u0000-\u001f\u007f]/u.test(value.name)) {
    invalid('name', '请填写有效站点名称。');
  }
  const template = value.template ?? 'newapi';
  if (!TEMPLATES.has(template as Template)) invalid('template', '请选择支持的签到模式。');
  const sub2api = String(template).startsWith('sub2api');
  const header = value.api_user_key ?? 'new-api-user';
  if (typeof header !== 'string' || header.length > 64) invalid('api_user_key', '用户标识请求头无效。');
  const apiUserKey = header.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(apiUserKey) || RESERVED_HEADERS.has(apiUserKey) || /^(?:sec-|proxy-)/.test(apiUserKey)) {
    invalid('api_user_key', '用户标识请求头无效。');
  }
  const unit = value.quota_per_unit ?? (sub2api ? 1 : 500000);
  if (typeof unit !== 'number' || !Number.isFinite(unit) || unit < 1 || unit > 1e12) invalid('quota_per_unit', '额度换算值必须介于 1 与 1000000000000 之间。');
  const currency = value.currency ?? 'USD';
  if (!CURRENCIES.has(currency as Currency)) invalid('currency', '请选择支持的额度单位。');
  const balanceOnly = template === 'balance' || template === 'sub2api_balance';
  if (value.sign_in_path !== undefined && value.sign_in_path !== null) sameSitePath(value.sign_in_path, 'sign_in_path');
  return {
    name: value.name.trim(), domain: normalizeProviderDomain(value.domain), template: template as Template,
    login_path: sameSitePath(value.login_path ?? '/login', 'login_path'),
    sign_in_path: balanceOnly ? null : sameSitePath(value.sign_in_path ?? (sub2api ? '/api/v1/user/check-in' : template === 'newapi' ? '/api/user/checkin' : '/api/user/sign_in'), 'sign_in_path'),
    user_info_path: sameSitePath(value.user_info_path ?? (sub2api ? '/api/v1/auth/me' : '/api/user/self'), 'user_info_path'),
    login_api_path: sameSitePath(value.login_api_path ?? (sub2api ? '/api/v1/auth/login' : '/api/user/login'), 'login_api_path'),
    api_user_key: apiUserKey, quota_per_unit: unit, currency: currency as Currency,
  };
}

export function providerFromConfig(id: string, data: unknown, active = true): Provider {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || typeof active !== 'boolean') throw new HttpError(422, '站点配置编号无效。');
  const parsed = parseProviderInput(data);
  return {
    ...parsed, name: id, display_name: parsed.name, custom: true, active,
    login_methods: [...BROWSER_METHODS, ...CREDENTIAL_METHODS], oauth_availability: 'detect_on_login',
    oauth_navigation_paths: [], waf_cookie_names: [], bypass_method: null, use_proxy: false,
    persist_profile: false, logout_path: null,
  };
}

function builtin(id: string, display: string, domain: string, overrides: Partial<Provider>): Provider {
  return {
    name: id, display_name: display, domain, custom: false, active: true, template: 'sign_in',
    login_path: '/login', sign_in_path: '/api/user/sign_in', user_info_path: '/api/user/self', login_api_path: '/api/user/login',
    api_user_key: 'new-api-user', quota_per_unit: 500000, currency: 'USD',
    login_methods: [...BROWSER_METHODS, ...CREDENTIAL_METHODS], oauth_availability: 'detect_on_login',
    oauth_navigation_paths: [], waf_cookie_names: [], bypass_method: null, use_proxy: false,
    persist_profile: false, logout_path: null, ...overrides,
  };
}

export const PROVIDERS: Record<string, Provider> = {
  anyrouter: builtin('anyrouter', 'AnyRouter', 'https://anyrouter.top', {
    bypass_method: 'waf_cookies', waf_cookie_names: ['acw_tc', 'cdn_sec_tc', 'acw_sc__v2'], oauth_navigation_paths: ['/register', '/login'],
  }),
  agentrouter: builtin('agentrouter', 'AgentRouter', 'https://agentrouter.org', {
    sign_in_path: null, logout_path: '/api/user/logout', bypass_method: 'waf_cookies', waf_cookie_names: ['acw_tc'], use_proxy: true,
  }),
};

export function loadCustomProviders(records: ProviderRecord[], registry: Record<string, Provider> = PROVIDERS): void {
  const custom: Record<string, Provider> = {};
  for (const record of records) {
    if (!BUILTIN_IDS.has(record.id)) custom[record.id] = providerFromConfig(record.id, record.config, record.active);
  }
  for (const key of Object.keys(registry)) if (!BUILTIN_IDS.has(key)) delete registry[key];
  Object.assign(registry, custom);
}

export function providerCatalog(registry: Record<string, Provider> = PROVIDERS): Record<string, unknown>[] {
  return Object.entries(registry).map(([id, provider]) => ({
    id, name: provider.display_name || provider.name, domain: provider.domain, custom: provider.custom, active: provider.active,
    template: provider.template, currency: provider.currency, quota_per_unit: provider.quota_per_unit,
    login_path: provider.login_path, sign_in_path: provider.sign_in_path, user_info_path: provider.user_info_path,
    api_user_key: provider.api_user_key, login_api_path: provider.login_api_path,
    login_methods: [...provider.login_methods], oauth_availability: provider.oauth_availability,
  }));
}

export function supports(registry: Record<string, Provider>, id: string, method: string): boolean {
  const provider = Object.hasOwn(registry, id) ? registry[id] : undefined;
  return Boolean(provider?.active && provider.login_methods.includes(method));
}
