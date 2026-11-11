export const CONNECTION_TTL = 20 * 60 * 1000;
export const MAX_SECRET_LENGTH = 32000;
export const STORAGE_KEY = 'checkinBrowserConnection';

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TICKET = /^[A-Za-z0-9_-]{20,256}$/;
const PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/;
const HEADER = /^[a-z][a-z0-9-]{0,63}$/;
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const INVALID_SECRET = /[^\x21-\x7e]|[;,]/;
const RESERVED_HEADERS = new Set(['cookie', 'authorization', 'host', 'origin', 'referer', 'content-type', 'content-length', 'connection', 'x-requested-with', 'accept', 'user-agent']);
const TEMPLATES = new Set(['newapi', 'sign_in', 'balance', 'sub2api', 'sub2api_balance']);
const ACTIVE_STATUSES = new Set(['starting', 'waiting', 'verifying', 'pending']);

export class BridgeError extends Error {}

function fail(message) {
  throw new BridgeError(message);
}

export function secureOrigin(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\s\\\x00-\x1f\x7f]/.test(value)) fail('助手地址格式无效。');
  let url;
  try { url = new URL(value); } catch { fail('助手地址格式无效。'); }
  if (url.username || url.password || !['', '/'].includes(url.pathname) || url.search || url.hash) fail('助手地址必须是完整的根网址，不含路径、账号或参数。');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) fail('助手须使用 HTTPS；本机 localhost 或 127.0.0.1 可以使用 HTTP。');
  return url.origin;
}

export function parseConnectionCode(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) fail('请粘贴签到助手生成的连接码。');
  let data;
  try { data = JSON.parse(raw); } catch { fail('连接码格式无效，请在签到助手中重新复制。'); }
  if (!data || data.version !== 1 || !IDENTIFIER.test(data.id || '') || !TICKET.test(data.ticket || '')) fail('连接码无效，请在签到助手中重新复制。');
  return {version: 1, origin: secureOrigin(data.origin), id: data.id, ticket: data.ticket};
}

function deadline(value, now) {
  let result;
  if (typeof value === 'number' && Number.isFinite(value)) result = value < 1e12 ? value * 1000 : value;
  else if (typeof value === 'string') result = Date.parse(value);
  if (!Number.isFinite(result) || result <= now) fail('连接码已过期，请在签到助手中重新生成。');
  return Math.min(result, now + CONNECTION_TTL);
}

export function parseDescriptor(data, connection, now = Date.now()) {
  if (!data || data.id !== connection.id || !ACTIVE_STATUSES.has(data.status)) fail('本次连接已结束，请回签到助手查看结果或重新开始。');
  const source = data.provider;
  if (!source || typeof source !== 'object' || !IDENTIFIER.test(source.id || '') || typeof source.name !== 'string' || !source.name || source.name.length > 100) fail('站点配置无效，请回签到助手重新选择。');
  const domain = secureOrigin(source.domain);
  if (domain === connection.origin) fail('目标站点不能与签到助手使用同一个地址。');
  if (!PATH.test(source.login_path || '') || !PATH.test(source.user_info_path || '') || !TEMPLATES.has(source.template)) fail('站点接口配置无效，请回签到助手核对。');
  const header = source.api_user_key;
  if (typeof header !== 'string' || !HEADER.test(header) || RESERVED_HEADERS.has(header) || /^(?:sec-|proxy-)/.test(header)) fail('站点身份请求头无效。');
  const method = data.method;
  if (!['github', 'linuxdo', 'manual'].includes(method)) fail('本次登录方式无效。');
  const waf = source.waf_cookie_names || [];
  if (!Array.isArray(waf) || waf.length > 12 || waf.some(name => typeof name !== 'string' || !COOKIE_NAME.test(name) || name === 'session')) fail('站点 Cookie 配置无效。');
  return {
    ...connection,
    name: typeof data.name === 'string' ? data.name.slice(0, 100) : '',
    method,
    expiresAt: deadline(data.expires_at, now),
    provider: {id: source.id, name: source.name, domain, login_path: source.login_path, user_info_path: source.user_info_path, api_user_key: header, template: source.template, waf_cookie_names: [...new Set(waf)]},
  };
}

export function importUrl(connection) {
  return `${connection.origin}/api/browser-import/${encodeURIComponent(connection.id)}`;
}

export function hostPattern(origin) {
  const url = new URL(secureOrigin(origin));
  // Chrome host permissions cover a host's ports; the bridge itself still
  // sends requests only to the exact paired origin, including its port.
  return `${url.protocol}//${url.hostname}/*`;
}

export function oauthRoots(connection) {
  if (connection.provider.id !== 'agentrouter') return [];
  return connection.method === 'github' ? ['github.com'] : connection.method === 'linuxdo' ? ['linux.do'] : [];
}

export function oauthPatterns(connection) {
  return oauthRoots(connection).flatMap(root => [`https://${root}/*`, `https://*.${root}/*`]);
}

export function requestedOrigins(connection, includeOAuth = false) {
  return [...new Set([hostPattern(connection.origin), hostPattern(connection.provider.domain), ...(includeOAuth ? oauthPatterns(connection) : [])])];
}

export function publicConnection(connection) {
  return {id: connection.id, origin: connection.origin, name: connection.name, method: connection.method, expiresAt: connection.expiresAt, provider: connection.provider, oauthAvailable: oauthRoots(connection).length > 0};
}

export function secretValue(value, message = '站点登录凭据格式无效，请重新登录原站后导入。') {
  if (typeof value !== 'string' || !value || value.length > MAX_SECRET_LENGTH || INVALID_SECRET.test(value)) fail(message);
  return value;
}

export function positiveUserId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || typeof value === 'boolean' || !/^[1-9][0-9]{0,19}$/.test(String(value))) fail('原站未确认有效的账号身份，请先完成登录。');
  return String(value);
}

export function normalizeCookie(cookie, now = Date.now()) {
  if (!cookie || typeof cookie.name !== 'string' || !COOKIE_NAME.test(cookie.name)) return null;
  // Match the server's replay format; unrelated JSON/consent cookies must not
  // prevent an otherwise valid upstream session from being imported.
  if (typeof cookie.value !== 'string' || !cookie.value || cookie.value.length > MAX_SECRET_LENGTH || INVALID_SECRET.test(cookie.value)) return null;
  if (typeof cookie.domain !== 'string' || !/^\.?[A-Za-z0-9.-]+$/.test(cookie.domain)) return null;
  const expires = cookie.session ? -1 : cookie.expirationDate ?? cookie.expires ?? -1;
  if (typeof expires !== 'number' || !Number.isFinite(expires) || (expires > 0 && expires * 1000 <= now)) return null;
  const path = typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\x00-\x1f\x7f]/.test(cookie.path) ? cookie.path : '/';
  const result = {name: cookie.name, value: cookie.value, domain: cookie.domain.toLowerCase(), path, expires, httpOnly: !!cookie.httpOnly, secure: !!cookie.secure};
  const sameSite = {no_restriction: 'None', lax: 'Lax', strict: 'Strict', None: 'None', Lax: 'Lax', Strict: 'Strict'}[cookie.sameSite];
  if (sameSite) result.sameSite = sameSite;
  // Partitioned cookies have a different browser context and cannot be replayed
  // as an ordinary first-party login on the server.
  if (cookie.partitionKey != null) return null;
  return result;
}

export function cookieMatches(cookie, urlValue, now = Date.now()) {
  const normal = normalizeCookie(cookie, now);
  if (!normal) return false;
  const url = new URL(urlValue), domain = normal.domain.replace(/^\./, '');
  const domainMatches = url.hostname === domain || (!cookie.hostOnly && url.hostname.endsWith(`.${domain}`));
  const pathMatches = url.pathname === normal.path || (url.pathname.startsWith(normal.path) && (normal.path.endsWith('/') || url.pathname[normal.path.length] === '/'));
  return domainMatches && pathMatches && (!normal.secure || url.protocol === 'https:');
}

export function targetCookies(cookies, provider, now = Date.now()) {
  const host = new URL(provider.domain).hostname;
  const names = new Set(provider.waf_cookie_names);
  return cookies.map(cookie => normalizeCookie(cookie, now)).filter(cookie => cookie && names.has(cookie.name) && cookie.domain.replace(/^\./, '') === host);
}

export function upstreamCookies(cookies, roots, storeId, now = Date.now()) {
  return cookies.filter(cookie => cookie.storeId === storeId).map(cookie => normalizeCookie(cookie, now)).filter(cookie => {
    if (!cookie) return false;
    const domain = cookie.domain.replace(/^\./, '');
    return roots.some(root => domain === root || domain.endsWith(`.${root}`));
  });
}

export function sameProvider(left, right) {
  return ['id', 'domain', 'template', 'user_info_path', 'api_user_key'].every(key => left[key] === right[key]);
}

export function safeMessage(error) {
  return error instanceof BridgeError ? error.message : '操作未完成，请检查连接和当前站点后重试。';
}
