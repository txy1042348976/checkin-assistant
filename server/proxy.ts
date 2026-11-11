import { HttpError, isRecord } from './errors.js';
import type { AppConfig, Provider, ProxyConfig } from './types.js';

export interface ResolvedProxy { server: string; username?: string; password?: string }
const KEYS = new Set(['mode', 'server', 'authenticate', 'username', 'password']);

function invalid(field = 'proxy_server', detail = '代理地址需为 http://主机:端口、https://主机:端口 或 socks5://主机:端口；认证信息请单独填写。'): never {
  throw new HttpError(422, detail, { fields: [field] });
}

function proxyUrl(source: string, embeddedAuth = false): { server: string; username?: string; password?: string } {
  if (!source || source.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(source)) invalid();
  let url: URL;
  try { url = new URL(source); } catch { return invalid(); }
  // URL removes an explicit default port. Parse the authority to preserve it.
  const authority = source.match(/^[a-z0-9]+:\/\/([^/]+)/i)?.[1]?.replace(/^.*@/, '') ?? '';
  const portMatch = authority.match(/(?:\]|[^:]):([0-9]+)$/);
  const explicitPort = portMatch ? Number(portMatch[1]) : undefined;
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || !explicitPort || explicitPort > 65535
      || (!embeddedAuth && (url.username || url.password)) || !['', '/'].includes(url.pathname) || url.search || url.hash) invalid();
  let username: string | undefined, password: string | undefined;
  if (url.username || url.password) {
    try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); } catch { return invalid(); }
    if (!username || !password || /[\u0000-\u001f\u007f]/u.test(username + password)) invalid();
  }
  if (url.protocol === 'socks5:' && (username || password)) invalid('proxy_auth', '当前后台 Chromium 不支持 SOCKS5 用户名密码认证，请使用 HTTP/HTTPS 认证代理。');
  return { server: `${url.protocol}//${url.hostname}:${explicitPort}`, ...(username ? { username, password } : {}) };
}

export function parseProxyInput(value: unknown): ProxyConfig {
  if (!isRecord(value)) throw new HttpError(422, '代理配置格式无效。', { fields: ['proxy_mode'] });
  if (Object.keys(value).some(key => !KEYS.has(key))) throw new HttpError(422, '代理配置包含不支持的字段。', { fields: ['proxy_mode'] });
  const mode = value.mode ?? 'default';
  if (!['default', 'direct', 'custom'].includes(String(mode))) throw new HttpError(422, '请选择有效的网络代理模式。', { fields: ['proxy_mode'] });
  if (value.authenticate !== undefined && typeof value.authenticate !== 'boolean') invalid('proxy_auth', '代理认证设置无效。');
  for (const [key, limit] of [['username', 300], ['password', 1000]] as const) {
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || value[key].length > limit || /[\u0000-\u001f\u007f]/u.test(value[key]))) {
      invalid(`proxy_${key}`, '代理认证信息格式无效。');
    }
  }
  if (mode !== 'custom') return { mode: mode as 'default' | 'direct' };
  if (typeof value.server !== 'string') invalid();
  const parsed = proxyUrl(value.server.trim());
  if (parsed.server.startsWith('socks5:') && value.authenticate === true) invalid('proxy_auth', '当前后台 Chromium 不支持 SOCKS5 用户名密码认证，请使用 HTTP/HTTPS 认证代理。');
  return {
    mode: 'custom', server: parsed.server, authenticate: value.authenticate === true,
    ...(typeof value.username === 'string' ? { username: value.username } : {}),
    ...(typeof value.password === 'string' ? { password: value.password } : {}),
  };
}

export function normalizeProxy(input: unknown, previous?: ProxyConfig): ProxyConfig {
  if (input === undefined || input === null) return previous ? structuredClone(previous) : { mode: 'default' };
  const parsed = parseProxyInput(input);
  if (parsed.mode !== 'custom') return { mode: parsed.mode };
  const result: ProxyConfig = { mode: 'custom', server: parsed.server, authenticate: parsed.authenticate === true };
  if (result.authenticate) {
    const sameServer = previous?.mode === 'custom' && previous.server === result.server;
    result.username = parsed.username === undefined && sameServer ? previous.username : parsed.username;
    result.password = parsed.password === undefined && sameServer ? previous.password : parsed.password;
    if (!result.username || !result.password) invalid('proxy_auth', '请填写代理用户名和密码；修改代理地址后需重新填写认证信息。');
  }
  return result;
}

export function publicProxy(config?: ProxyConfig | null): { mode: string; server: string; has_auth: boolean } {
  const mode = config && ['default', 'direct', 'custom'].includes(config.mode) ? config.mode : 'default';
  const result = { mode, server: '', has_auth: Boolean(mode === 'custom' && config?.authenticate) };
  if (mode !== 'custom' || !config?.server) return result;
  // Legacy encrypted records may contain auth inside a URL. Never reflect it into a page.
  try {
    const value = proxyUrl(config.server, true);
    result.server = value.server; result.has_auth ||= Boolean(value.username || value.password);
  } catch { /* Invalid legacy values are deliberately not rendered. */ }
  return result;
}

export function resolveProxy(provider: Pick<Provider, 'use_proxy'> | undefined, config?: ProxyConfig | ResolvedProxy | null, app?: Pick<AppConfig, 'defaultProxyUrl'>): ResolvedProxy | null {
  if (config && !('mode' in config)) {
    const resolved = proxyUrl(config.server);
    return { server: resolved.server, ...(config.username ? { username: config.username, password: config.password } : {}) };
  }
  if (config?.mode === 'direct') return null;
  if (config?.mode === 'custom') {
    const normalized = normalizeProxy(config);
    return { server: normalized.server!, ...(normalized.authenticate ? { username: normalized.username, password: normalized.password } : {}) };
  }
  return provider?.use_proxy && app?.defaultProxyUrl?.trim() ? proxyUrl(app.defaultProxyUrl.trim(), true) : null;
}

export function browserProxy(proxy: ResolvedProxy | null): { server: string; username?: string; password?: string } | undefined {
  return proxy ? { ...proxy } : undefined;
}

export function proxyAgentUrl(proxy: ResolvedProxy): URL {
  const url = new URL(proxy.server);
  if (proxy.username !== undefined) { url.username = proxy.username; url.password = proxy.password ?? ''; }
  return url;
}

export function proxyFailureMessage(error: unknown): string | null {
  const code = error instanceof Error ? `${error.name} ${(error as Error & { code?: string }).code ?? ''} ${error.message}` : '';
  if (/ERR_INVALID_AUTH_CREDENTIALS|ERR_PROXY_AUTH_|ERR_PROXY_CERTIFICATE_INVALID|EPROXYAUTH/.test(code)) return '代理认证或证书验证未通过，请检查该账号的代理配置。';
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ECONNREFUSED/.test(code)) return '代理连接失败，请检查该账号的代理地址、端口和代理服务。';
  return null;
}
