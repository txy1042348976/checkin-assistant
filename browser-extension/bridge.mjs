import {BridgeError, CONNECTION_TTL, STORAGE_KEY, cookieMatches, hostPattern, importUrl, oauthRoots, parseConnectionCode, parseDescriptor, positiveUserId, publicConnection, requestedOrigins, sameProvider, secretValue, targetCookies, upstreamCookies} from './helpers.mjs';

// Self-contained: Chrome serializes this function into the selected top frame.
// It performs one read-only, fresh request on the target site's own origin.
export async function inspectSite(provider) {
  const problem = {ok: false, message: '请先在原站完成登录，并打开该账号的控制台。'};
  if (location.origin !== provider.domain || window.top !== window) return problem;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const bearer = provider.template.startsWith('sub2api');
    let hint = null;
    try { hint = JSON.parse(localStorage.getItem('user')); } catch {}
    const headers = {'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest'};
    const token = bearer ? localStorage.getItem('auth_token') : null;
    if (bearer) {
      if (typeof token !== 'string' || !token || token.length > 32000 || /[^\x21-\x7e]|[;,]/.test(token)) return problem;
      headers.Authorization = `Bearer ${token}`;
      headers['X-User-UI-Request'] = '1';
    } else if (hint && /^(?:[1-9][0-9]{0,19})$/.test(String(hint.id))) headers[provider.api_user_key] = String(hint.id);
    const endpoint = new URL(provider.user_info_path, provider.domain);
    if (endpoint.origin !== location.origin) return problem;
    endpoint.searchParams.set('_checkin_assistant_verify', crypto.randomUUID());
    const response = await fetch(endpoint.href, {method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers, signal: controller.signal});
    if (location.origin !== provider.domain || response.status !== 200 || new URL(response.url).origin !== provider.domain || !/application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') || '')) return problem;
    const body = await response.json();
    const accepted = bearer ? typeof body?.code === 'number' && body.code === 0 : body?.success === true;
    const profile = accepted && body?.data;
    if (!profile || typeof profile.id === 'boolean' || !/^(?:[1-9][0-9]{0,19})$/.test(String(profile.id))) return problem;
    if (!bearer && hint?.id != null && String(hint.id) !== String(profile.id)) return {ok: false, message: '原站账号信息刚刚变化，请刷新原站控制台后再导入。'};
    const refresh = bearer ? localStorage.getItem('refresh_token') : null;
    if (bearer && localStorage.getItem('auth_token') !== token) return problem;
    return {ok: true, api_user: String(profile.id), session: token, refresh_token: typeof refresh === 'string' && refresh.length <= 32000 && !/[^\x21-\x7e]|[;,]/.test(refresh) ? refresh : null, oauth_user_agent: navigator.userAgent};
  } catch {
    return {ok: false, message: '原站账号校验未完成，请刷新原站控制台后再导入。'};
  } finally { clearTimeout(timeout); }
}

export function createBridge(browser, fetcher = globalThis.fetch, now = () => Date.now()) {
  let importing = false;

  async function readJson(connection, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.method === 'POST' ? 90000 : 15000);
    try {
      const response = await fetcher(importUrl(connection), {
        ...options,
        headers: {'Accept': 'application/json', ...(options.method === 'POST' ? {'Content-Type': 'application/json'} : {}), Authorization: `Bearer ${connection.ticket}`},
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new BridgeError('连接码无效或已过期，请回签到助手重新复制。');
        if (response.status === 404 || response.status === 409 || response.status === 410) throw new BridgeError('本次连接已结束，请回签到助手查看结果或重新开始。');
        if (response.status === 422) throw new BridgeError('后台未能验证本次登录状态，请回控制台查看原因；服务器网络或站点防护也可能阻止验证。');
        throw new BridgeError('助手暂时无法接收登录状态，请稍后重试。');
      }
      const text = await response.text();
      if (text.length > 256000) throw new BridgeError('助手响应异常，请回控制台检查连接。');
      let data;
      try { data = JSON.parse(text); } catch { throw new BridgeError('助手响应异常，请回控制台检查连接。'); }
      return data;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(options.method === 'POST' ? '发送结果尚未确认。请先回签到助手查看账号列表，再决定是否重试。' : '无法连接签到助手，请检查地址和服务状态。');
    } finally { clearTimeout(timeout); }
  }

  async function load() {
    const data = (await browser.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (!data) return null;
    if (!data.expiresAt || data.expiresAt <= now()) {
      await clear(data);
      return null;
    }
    return data;
  }

  async function clear(connection) {
    await browser.storage.session.remove(STORAGE_KEY);
    if (connection) {
      try { await browser.permissions.remove({origins: requestedOrigins(connection, true)}); } catch {}
    }
  }

  async function connect(raw) {
    if (importing) throw new BridgeError('正在导入，请等待当前操作完成。');
    const code = parseConnectionCode(raw);
    if (!await browser.permissions.contains({origins: [hostPattern(code.origin)]})) throw new BridgeError('请先允许连接码中该助手地址的访问权限。');
    const data = await readJson(code);
    const connection = parseDescriptor(data, code, now());
    connection.expiresAt = Math.min(connection.expiresAt, now() + CONNECTION_TTL);
    await browser.storage.session.set({[STORAGE_KEY]: connection});
    return {ok: true, connection: publicConnection(connection)};
  }

  async function importCredentials(message) {
    if (importing) throw new BridgeError('正在导入，请等待当前操作完成。');
    importing = true;
    try {
      const saved = await load();
      if (!saved || message.id !== saved.id) throw new BridgeError('连接码已过期或已更换，请重新连接。');
      const refreshed = parseDescriptor(await readJson(saved), saved, now());
      if (!sameProvider(saved.provider, refreshed.provider)) throw new BridgeError('站点配置已变化，请回签到助手重新生成连接码。');
      const connection = {...refreshed, expiresAt: Math.min(saved.expiresAt, refreshed.expiresAt)};
      const includeOAuth = message.include_oauth === true;
      if (includeOAuth && !oauthRoots(connection).length) throw new BridgeError('此站点无需导入上游登录状态。');
      if (!await browser.permissions.contains({origins: requestedOrigins(connection, includeOAuth)})) throw new BridgeError('请允许访问本次选定的站点后再导入。');
      const [tab] = await browser.tabs.query({active: true, currentWindow: true});
      let origin;
      try { origin = new URL(tab?.url).origin; } catch {}
      if (!tab?.id || tab.incognito || origin !== connection.provider.domain) throw new BridgeError(`请先切换到 ${connection.provider.name} 原站的登录后页面，再打开扩展。`);
      const stores = await browser.cookies.getAllCookieStores();
      const store = stores.find(item => item.tabIds.includes(tab.id));
      if (!store) throw new BridgeError('未能确定当前浏览器的 Cookie 空间，请刷新原站后重试。');
      const endpoint = connection.provider.domain + connection.provider.user_info_path;
      const bearer = connection.provider.template.startsWith('sub2api');
      const cookieBefore = bearer ? null : await browser.cookies.get({url: endpoint, name: 'session', storeId: store.id});
      if (!bearer && (!cookieBefore || cookieBefore.storeId !== store.id || !cookieMatches(cookieBefore, endpoint, now()))) throw new BridgeError('未找到该站点的登录 Session，请先在原站完成登录。');
      const results = await browser.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: 'MAIN', func: inspectSite, args: [connection.provider]});
      const result = results.find(item => item.frameId === 0)?.result;
      if (!result?.ok) throw new BridgeError('原站尚未确认登录身份，请刷新原站控制台后再导入。');
      const apiUser = positiveUserId(result.api_user);
      const cookieAfter = bearer ? null : await browser.cookies.get({url: endpoint, name: 'session', storeId: store.id});
      if (!bearer && (!cookieAfter || cookieAfter.storeId !== store.id || !cookieMatches(cookieAfter, endpoint, now()) || cookieBefore.value !== cookieAfter.value || cookieBefore.domain !== cookieAfter.domain || cookieBefore.path !== cookieAfter.path)) throw new BridgeError('原站登录状态刚刚变化，请刷新原站控制台后再导入。');
      const currentTab = await browser.tabs.get(tab.id);
      if (new URL(currentTab.url).origin !== origin) throw new BridgeError('原站页面已跳转，请完成登录后再导入。');
      const cookies = await browser.cookies.getAll({url: endpoint, storeId: store.id});
      let upstream = [];
      if (includeOAuth) {
        const groups = await Promise.all(oauthRoots(connection).map(domain => browser.cookies.getAll({domain, storeId: store.id})));
        upstream = upstreamCookies(groups.flat(), oauthRoots(connection), store.id, now());
        if (!upstream.length) throw new BridgeError('未读取到所选身份提供方的登录状态。请先在同一浏览器登录，或取消额外导入。');
      }
      const payload = {
        session: secretValue(bearer ? result.session : cookieAfter.value),
        api_user: apiUser,
        site_cookies: targetCookies(cookies.filter(cookie => cookie.storeId === store.id), connection.provider, now()),
        oauth_cookies: upstream,
        oauth_user_agent: typeof result.oauth_user_agent === 'string' ? result.oauth_user_agent.slice(0, 1000) : '',
        ...(bearer && result.refresh_token ? {refresh_token: secretValue(result.refresh_token)} : {}),
      };
      const response = await readJson(connection, {method: 'POST', body: JSON.stringify(payload)});
      if (!['success', 'saved', 'completed'].includes(response.status)) throw new BridgeError('助手还在核对登录状态，请回控制台查看当前进度。');
      await clear(connection);
      return {ok: true, saved: true, origin: connection.origin, providerName: connection.provider.name};
    } finally { importing = false; }
  }

  return async function handle(message) {
    if (!message || typeof message !== 'object') throw new BridgeError('操作无效。');
    if (message.action === 'state') {
      const connection = await load();
      return {ok: true, connection: connection ? publicConnection(connection) : null};
    }
    if (message.action === 'connect') return connect(message.code);
    if (message.action === 'import') return importCredentials(message);
    if (message.action === 'disconnect') {
      if (importing) throw new BridgeError('正在导入，请等待当前操作完成。');
      await clear(await load());
      return {ok: true, connection: null};
    }
    throw new BridgeError('操作无效。');
  };
}
