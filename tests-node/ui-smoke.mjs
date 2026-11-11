import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PASSWORD = 'Isolated-Node-Fixture-2026!';
export const USERNAME = 'fixture-owner';
export const SECRETS = {
  any: 'fixture-any-user-browser-session',
  agent: 'fixture-agent-user-browser-session',
  sub: 'fixture-sub2api-login-token',
  refresh: 'fixture-sub2api-refresh-token',
};

export async function until(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function ready(base, timeout = 45000) {
  return until(async () => {
    try {
      const response = await fetch(`${base}/api/health`, {signal: AbortSignal.timeout(1000)});
      const data = response.ok && await response.json();
      return data?.status === 'ok' ? data : false;
    } catch { return false; }
  }, 'isolated Node app health', timeout);
}

export class ApiClient {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async request(endpoint, {method = 'GET', body, csrf = method !== 'GET', auth = true, headers = {}} = {}) {
    const response = await fetch(this.base + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(35000),
      headers: {...(auth && this.cookie ? {Cookie: this.cookie} : {}),
        ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
        ...(csrf && this.csrf ? {'X-CSRF-Token': this.csrf} : {}), ...headers},
      ...(body !== undefined ? {body: JSON.stringify(body)} : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      if (cookie.startsWith('checkin_session=')) this.cookie = cookie.split(';')[0];
    }
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data?.csrf_token) this.csrf = data.csrf_token;
    return {status: response.status, data, text, headers: response.headers};
  }
  async json(endpoint, options) {
    const result = await this.request(endpoint, options);
    assert.ok(result.status >= 200 && result.status < 300, `${endpoint}: HTTP ${result.status}: ${result.text.slice(0, 200)}`);
    return result.data;
  }
}

export function fixtureProviders(origin) {
  const shared = {active: true, login_methods: ['github', 'linuxdo', 'manual', 'password', 'session'],
    oauth_availability: 'detect_on_login', oauth_navigation_paths: [], waf_cookie_names: [],
    bypass_method: null, use_proxy: false, persist_profile: false, logout_path: null,
    api_user_key: 'new-api-user', quota_per_unit: 500000, currency: 'USD'};
  return [
    {...shared, name: 'anyrouter', display_name: 'AnyRouter', custom: false, domain: origin,
      template: 'sign_in', login_path: '/any/login', login_api_path: '/any/login',
      user_info_path: '/any/user/self', sign_in_path: '/any/sign-in'},
    {...shared, name: 'agentrouter', display_name: 'AgentRouter', custom: false, domain: origin,
      template: 'balance', login_path: '/agent/login', login_api_path: '/agent/login',
      user_info_path: '/agent/user/self', sign_in_path: null},
    {...shared, name: 'fixture-sub2api', display_name: 'Sub2API 本地测试站', custom: true, domain: origin,
      template: 'sub2api', quota_per_unit: 1, login_path: '/sub/login', login_api_path: '/sub/login',
      user_info_path: '/sub/auth/me', sign_in_path: '/sub/check-in'},
  ];
}

export async function startFixture({host = '127.0.0.1', advertisedHost = '127.0.0.1'} = {}) {
  const state = {
    login_posts: {any: 0, agent: 0, sub: 0},
    checkin_posts: {any: 0, agent: 0, sub: 0},
    identity_reads: {any: 0, agent: 0, sub: 0},
    balances: {any: 50, agent: 80, sub: 12.75},
    delays: {any: 0, agent: 0, sub: 0},
    forbidden: [],
  };
  const ids = {any: '7', agent: '9', sub: '11'};
  const used = {any: 10, agent: 4};
  const json = (response, status, body, extra = {}) => {
    response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra});
    response.end(JSON.stringify(body));
  };
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture.invalid');
      if (url.pathname === '/fixture/state') return json(response, 200, state);
      if (url.pathname === '/fixture/control' && request.method === 'POST') {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        if (body.delay && body.provider in state.delays) state.delays[body.provider] = Number(body.delay);
        return json(response, 200, {ok: true});
      }
      const group = url.pathname.split('/')[1];
      if (!Object.hasOwn(ids, group)) {
        response.writeHead(404); response.end('Local fixture route not found'); return;
      }
      const bearer = group === 'sub';
      if (url.pathname === `/${group}/login` && request.method === 'GET') {
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>本地原站 · ${group}</title></head>
          <body style="font:16px system-ui;background:#f3f8f6;color:#254c43;padding:64px;max-width:650px">
          <h1>用户浏览器 · 本地原站</h1><p>这是隔离测试站点，不连接真实账户。</p>
          <label>原站输入<input id="site-input" aria-label="原站输入"></label>
          <button id="fixture-login">登录本地测试账号</button><p id="logged-in" hidden>原站已登录</p>
          <script>document.querySelector('#fixture-login').onclick=async()=>{
            const r=await fetch('/${group}/login',{method:'POST'});const body=await r.json();
            localStorage.setItem('user',JSON.stringify({id:body.id}));
            ${bearer ? "localStorage.setItem('auth_token',body.token);localStorage.setItem('refresh_token',body.refresh_token);" : ''}
            document.querySelector('#logged-in').hidden=false;
          };</script></body></html>`);
        return;
      }
      if (url.pathname === `/${group}/login` && request.method === 'POST') {
        state.login_posts[group]++;
        return json(response, 200, {id: ids[group], ...(bearer ? {token: SECRETS.sub, refresh_token: SECRETS.refresh} : {})},
          bearer ? {} : {'Set-Cookie': `session=${SECRETS[group]}; Path=/${group}; HttpOnly; SameSite=Lax`});
      }
      const valid = bearer
        ? request.headers.authorization === `Bearer ${SECRETS.sub}`
        : request.headers.cookie?.split(';').some(item => item.trim() === `session=${SECRETS[group]}`)
          && request.headers['new-api-user'] === ids[group];
      if (url.pathname === `/${group}/user/self` || url.pathname === '/sub/auth/me') {
        state.identity_reads[group]++;
        if (state.delays[group]) {
          const milliseconds = state.delays[group]; state.delays[group] = 0;
          await delay(milliseconds);
        }
        if (!valid) return json(response, 401, bearer ? {code: 1, message: 'Fixture login required'} : {success: false, message: 'Fixture login required'});
        const data = bearer ? {id: Number(ids[group]), balance: state.balances[group]}
          : {id: Number(ids[group]), username: `Fixture ${group}`, quota: state.balances[group] * 500000,
            used_quota: used[group] * 500000};
        return json(response, 200, bearer ? {code: 0, data} : {success: true, data});
      }
      if (url.pathname === '/any/sign-in' || url.pathname === '/sub/check-in') {
        assert.equal(request.method, 'POST');
        if (!valid) return json(response, 401, {success: false});
        state.checkin_posts[group]++;
        if (state.checkin_posts[group] > 1) return json(response, 200, bearer
          ? {code: 1, reason: 'CHECK_IN_ALREADY_DONE'} : {success: false, message: 'already checked'});
        state.balances[group] += bearer ? 2.5 : 1;
        return json(response, 200, bearer ? {code: 0, data: {reward: 2.5}} : {success: true, message: 'Fixture check-in confirmed'});
      }
      state.forbidden.push(`${request.method} ${url.pathname}`);
      return json(response, 404, {message: 'Unexpected fixture operation'});
    } catch {
      if (!response.headersSent) json(response, 500, {message: 'Local fixture failed'});
      else response.end();
    }
  });
  server.on('upgrade', (_request, socket) => { state.forbidden.push('WebSocket'); socket.destroy(); });
  await new Promise(resolve => server.listen(0, host, resolve));
  const port = server.address().port;
  return {origin: `http://${advertisedHost}:${port}`, control: `http://127.0.0.1:${port}`,
    state, providers: fixtureProviders(`http://${advertisedHost}:${port}`),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }};
}

function browserPath() {
  const explicit = process.env.CHECKIN_BROWSER_PATH;
  const options = [explicit, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'].filter(Boolean);
  const executable = options.find(candidate => existsSync(candidate));
  assert.ok(executable, 'Install system Chrome/Chromium or set CHECKIN_BROWSER_PATH');
  return executable;
}

export async function runUiSmoke({base, fixtureOrigin, fixtureControl = fixtureOrigin, username = 'admin', password = PASSWORD, output}) {
  assert.notEqual(new URL(base).port, '8766', 'This smoke must not use the live local preview');
  await mkdir(output, {recursive: true});
  const report = {result: 'running', started_at: new Date().toISOString(), checks: [], javascript_errors: [], forbidden_requests: [], screenshots: []};
  const mark = name => { report.checks.push(name); console.log(`${name}: passed`); };
  const health = await ready(base);
  assert.equal(health.runtime, 'node'); assert.match(health.node, /^v24\./);
  report.runtime = health;
  const api = new ApiClient(base);
  assert.equal((await api.request('/api/bootstrap')).status, 401);
  for (const endpoint of ['/browser', '/api/browser/status', '/browser/vendor/core/rfb.js']) {
    assert.equal((await api.request(endpoint)).status, 404);
  }
  const browser = await chromium.launch({executablePath: browserPath(), headless: true,
    args: new URL(fixtureOrigin).hostname === 'host.docker.internal' ? ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'] : []});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
  const origins = new Set([new URL(base).origin, new URL(fixtureOrigin).origin]);
  const setupRequests = [];
  const observeContext = async target => {
    await target.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!origins.has(url.origin)) { report.forbidden_requests.push(url.href); return route.abort(); }
      if (/^\/(?:browser(?:\/|$)|api\/browser(?:\/|$))/.test(url.pathname)) report.forbidden_requests.push(url.href);
      return route.continue();
    });
    target.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === new URL(base).origin && url.pathname === '/api/auth/setup' && request.method() === 'POST') setupRequests.push(request);
    });
    target.on('page', observed => {
      observed.on('pageerror', error => report.javascript_errors.push(error.message));
      observed.on('websocket', socket => report.forbidden_requests.push(socket.url()));
      observed.on('console', message => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) report.javascript_errors.push(message.text());
      });
    });
  };
  await observeContext(context);
  const page = await context.newPage();
  const visible = selector => page.locator(selector).waitFor({state: 'visible'});
  const text = (selector, value) => until(async () => (await page.locator(selector).innerText()).includes(value), `${selector} contains ${value}`);
  const shot = async (name, target = page) => {
    if (await target.locator('#toast').count()) await target.locator('#toast').evaluate(element => element.classList.remove('show'));
    assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name);
    if (await target.locator('#modal').isVisible()) assert.ok(await target.locator('#modal').evaluate(element => element.scrollWidth <= element.clientWidth), name);
    const filename = path.join(output, name);
    await target.screenshot({path: filename, fullPage: true, animations: 'disabled'});
    report.screenshots.push(filename);
  };
  const syncApi = async () => {
    api.cookie = (await context.cookies(base)).filter(cookie => cookie.name === 'checkin_session').map(cookie => `${cookie.name}=${cookie.value}`).join(';');
    return api.json('/api/bootstrap');
  };
  const checkDistribution = async data => {
    const expected = new Map();
    for (const account of data.accounts) {
      const name = data.providers.find(provider => provider.id === account.provider)?.name || account.provider;
      expected.set(name, (expected.get(name) || 0) + 1);
    }
    const displayed = await page.locator('.distribution-label').evaluateAll(labels => labels.map(label => ({
      name: label.firstElementChild.textContent.trim(),
      count: Number(label.lastElementChild.textContent.match(/^(\d+)\s+个/)?.[1]),
    })));
    assert.deepEqual(displayed.map(row => [row.name, row.count]).sort(), [...expected].sort(), 'distribution counts every provider account');
    assert.equal(displayed.reduce((total, row) => total + row.count, 0), data.accounts.length, 'distribution counts sum to all accounts');
    await text('.distribution-panel .panel-sub', `${data.accounts.length} 个账号`);
    assert.ok(!/\$|¥|USD|CNY|积分/.test(await page.locator('.distribution-panel').innerText()), 'account distribution does not aggregate currencies or balances');
  };
  const fixtureState = async () => (await fetch(`${fixtureControl}/fixture/state`)).json();
  const advancedSettings = async (open=true) => {
    if (await page.locator('#account-advanced').evaluate(el => el.open) !== open) await page.locator('#account-advanced summary').click();
  };
  const manualDefault = async () => {
    await visible('#account-form [name="session"]');
    await visible('#account-form [name="api_user"]');
    assert.equal(await page.getByLabel('所属站点', {exact: true}).getAttribute('id'), 'account-provider');
    assert.equal(await page.locator('[data-method="session"]').evaluate(el => el.classList.contains('active')), true);
    assert.equal(await page.locator('[data-method="github"],[data-method="linuxdo"],[data-method="manual"]').count(), 0);
    assert.equal(await page.locator('#local-connector-connect,#local-connector-download,#connector-copy-button,#optional-browser-extension').count(), 0);
    assert.equal(await page.locator('#credential-help').evaluate(el => el.open), false);
    assert.equal(await page.locator('#account-advanced').evaluate(el => el.open), false);
    assert.equal(await page.locator('iframe').count(), 0);
  };
  const addBrowser = async (provider, name) => {
    const pagesBefore = context.pages().length;
    await page.locator('[data-action="add"]').first().click();
    await manualDefault();
    await page.locator('#account-form [name="name"]').fill(name);
    await page.getByLabel('所属站点', {exact: true}).selectOption(provider);
    await advancedSettings(); await page.locator('#proxy-mode').selectOption('direct'); await advancedSettings(false);
    assert.equal(context.pages().length, pagesBefore, 'manual form opens no other browser tab');
    await page.locator('#credential-help summary').click();
    const opened = page.waitForEvent('popup');
    await page.locator('#credential-site-link').click();
    const original = await opened;
    const group = provider === 'fixture-sub2api' ? 'sub' : provider === 'agentrouter' ? 'agent' : 'any';
    await original.waitForURL(`${fixtureOrigin}/${group}/login`);
    assert.equal(await original.evaluate(() => window.opener === null), true);
    await original.locator('#fixture-login').click();
    await original.locator('#logged-in').waitFor({state: 'visible'});
    return original;
  };
  const importManual = async (session, id) => {
    await page.locator('#account-form [name="session"]').fill(session);
    await page.locator('#account-form [name="api_user"]').fill(id);
    await page.locator('#account-submit').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#account-form [name="session"]').inputValue(), '');
    assert.equal(await page.locator('#account-form [name="api_user"]').inputValue(), '');
  };
  const expectAuthError = async (message, fields, target = page) => {
    await target.locator('#auth-form-error').waitFor({state: 'visible'});
    await until(async () => await target.locator('#auth-form-error').innerText() === message,
      `authentication error: ${message}`);
    await until(async () => await target.locator('#auth-form').getAttribute('aria-busy') === null,
      'authentication form finishes its submission');
    assert.deepEqual((await target.locator('#auth-form [aria-invalid="true"]').evaluateAll(inputs => inputs.map(input => input.id))).sort(),
      [...fields].sort(), 'only affected authentication fields are marked invalid');
    for (const id of fields) {
      const described = (await target.locator(`#${id}`).getAttribute('aria-describedby') || '').split(/\s+/);
      assert.ok(described.includes('auth-form-error'), `${id} is associated with the visible error`);
    }
    assert.equal(await target.evaluate(() => document.activeElement?.id), fields[0], 'authentication validation focuses the first affected field');
  };
  let staleSetupContext, staleSetupPage;
  try {
    await page.goto(base, {waitUntil: 'networkidle'});
    assert.equal(await page.title(), '签到助手');
    await visible('#auth-form');
    const auth = await api.json('/api/auth/status');
    if (auth.setup_required) {
      assert.equal(auth.configured, false); assert.equal(auth.authenticated, false); assert.equal(auth.username, null);
      assert.equal(await page.locator('#auth-form').getAttribute('data-setup'), 'true');
      assert.equal(await page.locator('.auth-form-wrap > h2').innerText(), '设置登录账号');
      assert.equal(await page.locator('.auth-form-wrap > p').innerText(), '首次使用，请设置账号和密码。以后使用这组凭据登录。');
      assert.deepEqual(await page.locator('#auth-form input').evaluateAll(inputs => inputs.map(input => input.name)),
        ['username', 'password', 'confirm_password'], 'first-run setup asks only for the chosen credentials');
      assert.equal(await page.locator('#setup-token,[name="setup_token"]').count(), 0);
      assert.equal(await page.locator('#auth-username').inputValue(), '', 'first-run username has no default');
      assert.equal(await page.locator('#auth-password').inputValue(), '');
      assert.equal(await page.locator('#auth-confirm').inputValue(), '');
      await shot('setup-desktop.png');
      await page.setViewportSize({width: 390, height: 844}); await shot('setup-mobile.png');
      await page.setViewportSize({width: 1440, height: 1000});
      staleSetupContext = await browser.newContext({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
      await observeContext(staleSetupContext);
      staleSetupPage = await staleSetupContext.newPage();
      await staleSetupPage.goto(base, {waitUntil: 'networkidle'});
      await staleSetupPage.locator('#auth-confirm').waitFor({state: 'visible'});
      const rejectedSetup = async (message, fields) => {
        const requestsBefore = setupRequests.length;
        await page.locator('#auth-form [type="submit"]').click();
        await expectAuthError(message, fields);
        const status = await api.json('/api/auth/status');
        assert.equal(status.configured, false); assert.equal(status.setup_required, true); assert.equal(status.authenticated, false);
        assert.equal(setupRequests.length, requestsBefore, 'invalid first-run credentials are rejected before sending a setup request');
      };
      await rejectedSetup('请填写完整的登录账号、密码和确认密码。', ['auth-username', 'auth-password', 'auth-confirm']);
      await shot('setup-validation-desktop.png');
      await page.locator('#auth-password').fill(password);
      await page.locator('#auth-confirm').fill(password);
      for (const invalidUsername of ['a', 'invalid username']) {
        await page.locator('#auth-username').fill(invalidUsername);
        await rejectedSetup('登录账号须为 2–40 个英文字母、数字、点、下划线或连字符。', ['auth-username']);
      }
      await page.locator('#auth-username').fill(username);
      for (const weakPassword of ['short', 'abcdefghijklmn', 'Password1234!']) {
        await page.locator('#auth-password').fill(weakPassword);
        await page.locator('#auth-confirm').fill(weakPassword);
        await rejectedSetup('登录密码须为 12–1024 个字符，包含字母、数字或符号中的至少两类，并避免常见默认密码。', ['auth-password']);
      }
      await page.locator('#auth-password').fill(password);
      await page.locator('#auth-confirm').fill(`${password}-different`);
      await rejectedSetup('两次输入的密码不一致。', ['auth-confirm']);
      assert.equal(setupRequests.length, 0);
      report.first_run = {username_initially_empty: true, setup_token_absent: true, validation_before_setup_request: true,
        missing_fields_rejected: true, invalid_username_rejected: true, weak_password_rejected: true, confirmation_mismatch_rejected: true};
      mark('token-free first-run setup starts blank and validates all credentials before sending any setup request');
      await page.locator('#auth-password').fill(password);
      await page.locator('#auth-confirm').fill(password);
    } else {
      assert.equal(await page.locator('#auth-confirm,#setup-token,[name="setup_token"]').count(), 0);
      await page.locator('#auth-username').fill(username);
      await page.locator('#auth-password').fill(password);
    }
    const authenticationEndpoint = auth.setup_required ? '/api/auth/setup' : '/api/auth/login';
    const authenticationResponse = page.waitForResponse(response => new URL(response.url()).pathname === authenticationEndpoint
      && response.request().method() === 'POST');
    await page.locator('#auth-form [type="submit"]').click();
    const authenticatedResponse = await authenticationResponse;
    assert.equal(authenticatedResponse.status(), 200);
    assert.deepEqual(authenticatedResponse.request().postDataJSON(), {username, password}, 'authentication sends only username and password');
    await visible('#workspace-shell');
    await text('#nav-count', '0');
    await text('#user-name', username);
    let state = await syncApi();
    const authenticatedStatus = await api.json('/api/auth/status');
    assert.equal(authenticatedStatus.authenticated, true); assert.equal(authenticatedStatus.configured, true);
    assert.equal(authenticatedStatus.setup_required, false); assert.equal(authenticatedStatus.username, username);
    if (auth.setup_required) {
      assert.equal(setupRequests.length, 1);
      report.first_run.direct_login = true; report.first_run.administrator_username = username;
      const replacementUsername = 'replacement-owner', replacementPassword = 'Replacement-Fixture-Password-2026!';
      await staleSetupPage.locator('#auth-username').fill(replacementUsername);
      await staleSetupPage.locator('#auth-password').fill(replacementPassword);
      await staleSetupPage.locator('#auth-confirm').fill(replacementPassword);
      const conflictResponse = staleSetupPage.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/setup'
        && response.request().method() === 'POST');
      await staleSetupPage.locator('#auth-form [type="submit"]').click();
      const conflict = await conflictResponse;
      assert.equal(conflict.status(), 409); assert.equal((await conflict.json()).detail, '管理员账号已经配置。');
      await until(async () => await staleSetupPage.locator('#auth-form').getAttribute('data-setup') === 'false',
        'a stale first-run page transitions to ordinary login');
      await expectAuthError('登录账号已经设置，请使用已设置的账号和密码登录。', ['auth-username', 'auth-password'], staleSetupPage);
      assert.equal(await staleSetupPage.locator('#auth-confirm,#setup-token,[name="setup_token"]').count(), 0);
      assert.equal(await staleSetupPage.locator('#auth-username').inputValue(), replacementUsername);
      assert.equal(await staleSetupPage.locator('#auth-password').inputValue(), '', 'the stale setup password is discarded');
      assert.equal(await staleSetupPage.locator('.auth-form-wrap > h2').innerText(), '登录签到助手');
      assert.equal(await staleSetupPage.locator('#auth-form [type="submit"]').innerText(), '登录工作空间');
      assert.equal((await staleSetupContext.cookies(base)).filter(cookie => cookie.name === 'checkin_session').length, 0);
      assert.equal(setupRequests.length, 2, 'a rejected setup is not retried automatically');
      const retainedStatus = await api.json('/api/auth/status');
      assert.equal(retainedStatus.authenticated, true); assert.equal(retainedStatus.username, username);
      const publicStatus = await new ApiClient(base).json('/api/auth/status');
      assert.equal(publicStatus.authenticated, false); assert.equal(publicStatus.configured, true); assert.equal(publicStatus.setup_required, false);
      await shot('setup-already-configured.png', staleSetupPage);
      await staleSetupContext.close(); staleSetupContext = null; staleSetupPage = null;
      report.first_run.repeat_setup_http_status = 409; report.first_run.stale_setup_returns_to_login = true;
      mark('stale first-run tab cannot replace the administrator and returns to ordinary login on HTTP 409');
    }
    await api.json('/api/settings', {method: 'PATCH', body: {scheduler_enabled: false, interval_hours: 6}});
    state = await syncApi();
    for (const endpoint of ['/API/BROWSER/status', '/API/not-an-api']) assert.equal((await api.request(endpoint)).status, 404);
    assert.equal(state.web.authorization_mode, 'manual'); assert.equal(state.web.remote_browser, false);
    assert.equal((await api.request('/api/run-all', {method: 'POST', body: {}, csrf: false})).status, 403);
    assert.equal((await api.request('/api/auth/status', {headers: {Origin: 'https://attacker.invalid'}})).status, 403);
    assert.equal((await context.cookies(base)).find(cookie => cookie.name === 'checkin_session').httpOnly, true);
    await shot('overview-empty.png');
    mark('actual Node administrator setup/login, HttpOnly session, CSRF and origin checks');
    assert.equal(await page.locator('.quick-panel [data-action="accounts-export"]').isEnabled(), false, 'empty overview cannot export accounts');
    await checkDistribution(state);

    const original = await addBrowser('anyrouter', '手动填写 · AnyRouter');
    assert.equal((await context.cookies(`${fixtureOrigin}/any/user/self`)).find(cookie => cookie.name === 'session').httpOnly, true);
    state = await syncApi(); assert.equal(state.authorization, null);
    assert.equal(state.runs.length, 0); assert.equal((await fixtureState()).checkin_posts.any, 0);
    await original.locator('#site-input').fill('原站标签页保留');
    await page.locator('#account-form [name="session"]').fill('invalid-fixture-session');
    await page.locator('#account-form [name="api_user"]').fill('7');
    await page.locator('#account-submit').click(); await visible('#account-form [role="alert"]');
    assert.equal((await syncApi()).accounts.length, 0);
    assert.equal(await page.locator('#account-form [name="session"]').inputValue(), 'invalid-fixture-session');
    await shot('manual-import-rejected.png');
    await page.locator('#credential-help summary').click();
    await page.reload({waitUntil: 'networkidle'});
    assert.equal(await page.locator('#modal').isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    assert.equal(context.pages().length, 2); assert.equal(original.isClosed(), false);
    await page.locator('[data-action="add"]').first().click(); await manualDefault();
    await shot('manual-entry-desktop.png');
    await page.setViewportSize({width: 1366, height: 768});
    assert.equal(await page.locator('#account-submit').evaluate(el => {const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}), true);
    await shot('manual-entry-laptop.png'); await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('#account-form [name="name"]').fill('手动填写 · AnyRouter');
    await advancedSettings(); await page.locator('#proxy-mode').selectOption('direct'); await advancedSettings(false);
    const requestIds = [];
    await page.route('**/api/accounts/import', async route => {
      requestIds.push(route.request().postDataJSON().request_id);
      if (requestIds.length === 1) { await route.fetch(); return route.abort('failed'); }
      return route.continue();
    });
    await page.locator('#account-form [name="session"]').fill(SECRETS.any);
    await page.locator('#account-form [name="api_user"]').fill('7');
    await page.locator('#account-submit').click(); await visible('#account-form [role="alert"]');
    assert.equal((await syncApi()).accounts.length, 1, 'lost reply must not lose the saved account');
    assert.equal(await page.locator('#account-form [name="session"]').inputValue(), SECRETS.any);
    await page.locator('#account-submit').click(); await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal(requestIds.length, 2); assert.equal(requestIds[0], requestIds[1]);
    assert.match(requestIds[0], /^[a-f0-9]{32}$/);
    assert.equal((await syncApi()).accounts.length, 1, 'retry uses the same request and saves one account');
    await page.unroute('**/api/accounts/import');
    state = await syncApi();
    const any = state.accounts.find(account => account.provider === 'anyrouter');
    assert.equal(any.balance, 50); assert.equal(any.used_quota, 10); assert.equal(state.runs.length, 0);
    assert.equal(original.isClosed(), false); assert.equal(await original.locator('#site-input').inputValue(), '原站标签页保留');
    assert.ok(!JSON.stringify(state).includes(SECRETS.any));
    mark('default manual credential fields, explicit noopener site link, rejection/retry and no stored browser credentials');
    mark('lost successful import reply retries with the same request ID and saves no duplicate account');

    const agentOriginal = await addBrowser('agentrouter', '手动填写 · AgentRouter');
    await text('#credential-provider-hint', '不代表已领取登录奖励');
    await importManual(SECRETS.agent, '9');
    assert.equal(agentOriginal.isClosed(), false);
    state = await syncApi();
    const agent = state.accounts.find(account => account.provider === 'agentrouter');
    assert.equal(agent.balance, 80); assert.equal(state.runs.length, 0);
    mark('AgentRouter manual Session identity/balance save creates no login or check-in');

    const subOriginal = await addBrowser('fixture-sub2api', '手动填写 · Sub2API');
    await text('#credential-help-instructions', 'auth_token');
    await text('#credential-help-instructions', '不是模型 API Key');
    await text('#credential-session-label', '登录 Token');
    await page.locator('#account-form [name="session"]').fill(SECRETS.sub);
    await page.locator('#account-form [name="api_user"]').fill('11');
    await shot('sub2api-token-import.png');
    await importManual(SECRETS.sub, '11');
    state = await syncApi();
    const sub = state.accounts.find(account => account.provider === 'fixture-sub2api');
    assert.equal(sub.balance, 12.75); assert.equal(sub.used_quota, null); assert.equal(state.runs.length, 0);
    assert.equal(subOriginal.isClosed(), false);
    mark('Sub2API direct manual Token fields and same-site identity verification');

    const loginPostsBeforePassword = (await fixtureState()).login_posts;
    await page.locator('[data-action="add"]').first().click(); await manualDefault();
    await page.locator('[name="provider"]').selectOption('agentrouter');
    await page.locator('[data-method="password"]').click();
    assert.equal(await page.locator('#account-form [name="provider"]').inputValue(), 'agentrouter');
    await text('#credential-login-label', '用户名或邮箱');
    assert.equal(await page.locator('#account-form [name="email"]').getAttribute('type'), 'text');
    assert.equal(await page.locator('#account-form [name="session"]').count(), 0);
    await text('#credential-provider-hint', '服务器网络');
    await text('#account-submit', '保存账号');
    await page.locator('#account-form [name="name"]').fill('AgentRouter · 站内密码');
    await page.locator('#account-form [name="email"]').fill('fixture-agent-user');
    await page.locator('#account-form [name="password"]').fill('Fixture-Agent-Site-Password!');
    await advancedSettings(); await page.locator('#proxy-mode').selectOption('direct'); await advancedSettings(false);
    await shot('agent-password-desktop.png');
    await page.locator('#account-submit').click(); await page.locator('#modal').waitFor({state: 'hidden'});
    state = await syncApi();
    const passwordAccount = state.accounts.find(account => account.name === 'AgentRouter · 站内密码');
    assert.equal(passwordAccount.auth_mode, 'password'); assert.equal(passwordAccount.balance, null);
    assert.deepEqual((await fixtureState()).login_posts, loginPostsBeforePassword, 'saving a password does not claim or execute login');
    assert.ok(!JSON.stringify(state).includes('Fixture-Agent-Site-Password!'));
    await api.json(`/api/accounts/${passwordAccount.id}`, {method: 'DELETE', body: {}}); await page.evaluate(() => refresh(true));
    mark('AgentRouter accepts site username/password fields and saves encrypted credentials without claiming successful login');

    await page.locator('.nav-item[data-view="overview"]').click();
    const beforeQuickActions = await syncApi();
    const quickMutationCalls = [];
    const trackQuickMutation = request => {
      if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) quickMutationCalls.push(request.url());
    };
    page.on('request', trackQuickMutation);
    try {
      for (const [action, form] of [
        ['add', '#account-form'], ['accounts-import', '#account-import-form'], ['accounts-export', '#account-export-form'],
        ['add-site', '#provider-form'], ['settings', '#settings-form'],
      ]) {
        const trigger = page.locator(`.quick-panel [data-action="${action}"]`);
        assert.equal(await trigger.isEnabled(), true, `${action}: shortcut is available`);
        await trigger.click(); await visible(form);
        const beforeCancelRefresh = await trigger.elementHandle();
        await page.evaluate(() => refresh(true));
        await until(() => beforeCancelRefresh.evaluate(element => !element.isConnected), `${action}: workspace refreshed with dialog open`);
        await beforeCancelRefresh.dispose();
        await visible(form);
        await page.locator('#modal').getByRole('button', {name: '取消', exact: true}).click();
        await page.locator('#modal').waitFor({state: 'hidden'});
        assert.equal(await trigger.evaluate(element => document.activeElement === element), true, `${action}: cancel restores shortcut focus`);
        const beforeFocusRefresh = await trigger.elementHandle();
        await page.evaluate(() => refresh(true));
        await until(() => beforeFocusRefresh.evaluate(element => !element.isConnected), `${action}: workspace refreshed with shortcut focused`);
        await beforeFocusRefresh.dispose();
        assert.equal(await trigger.evaluate(element => document.activeElement === element), true, `${action}: refresh preserves shortcut focus`);
      }
      await page.locator('.quick-panel [data-view="logs"]').click();
      await visible('.logs-panel'); assert.equal(new URL(page.url()).hash, '#logs');
      assert.equal(await page.locator('.nav-item[data-view="logs"]').getAttribute('aria-current'), 'page');
      await page.locator('.nav-item[data-view="overview"]').click();
    } finally {
      page.off('request', trackQuickMutation);
    }
    const afterQuickActions = await syncApi();
    for (const field of ['accounts', 'providers', 'settings', 'runs']) assert.deepEqual(afterQuickActions[field], beforeQuickActions[field], `cancelling shortcuts preserves ${field}`);
    assert.deepEqual(quickMutationCalls, [], 'shortcut navigation and cancellation perform no writes or site tasks');
    mark('overview shortcuts open their existing forms, cancel without writes, route to logs and disable empty export');

    await page.locator('.nav-item[data-view="accounts"]').click();
    await page.locator('#account-search').fill('AnyRouter');
    assert.equal(await page.locator('.account-table tbody tr').count(), 1);
    await page.locator('[data-filter="agentrouter"]').click();
    await text('.account-table tbody', '没有匹配的账号');
    const overviewAccounts = (await syncApi()).accounts;
    await page.locator('.nav-item[data-view="overview"]').click();
    assert.equal(await page.locator('#overview-accounts tbody tr').count(), overviewAccounts.length);
    for (const account of overviewAccounts) await text('#overview-accounts', account.name);
    await checkDistribution(await syncApi());
    await page.locator('.nav-item[data-view="accounts"]').click();
    assert.equal(await page.locator('#account-search').inputValue(), 'AnyRouter');
    assert.equal(await page.locator('[data-filter="agentrouter"]').getAttribute('aria-pressed'), 'true');
    await text('.account-table tbody', '没有匹配的账号');
    await page.locator('[data-filter="all"]').click();
    await page.locator('#account-search').fill('');
    mark('overview retains all accounts while account-page search and provider filters remain independent');

    await page.locator('.nav-item[data-view="overview"]').click();
    const beforeDistributionScenario = await syncApi();
    const mixedDistribution = {
      ...beforeDistributionScenario,
      providers: [...beforeDistributionScenario.providers, {...beforeDistributionScenario.providers[0], id: 'inactive-reference-fixture', name: '已停用测试站点', active: false}],
      accounts: [
        ...beforeDistributionScenario.accounts.map((account, index) => ({...account, currency: index === 0 ? 'CNY' : 'USD'})),
        {...beforeDistributionScenario.accounts[0], id: 901, name: '分布 · 未知站点一', provider: 'unknown-reference-fixture', currency: 'CNY', balance: 999.5},
        {...beforeDistributionScenario.accounts[0], id: 902, name: '分布 · 未知站点二', provider: 'unknown-reference-fixture', currency: 'USD', balance: 999.5},
        {...beforeDistributionScenario.accounts[0], id: 903, name: '分布 · 停用站点', provider: 'inactive-reference-fixture', currency: 'USD', balance: 999.5},
      ],
    };
    const distributionBootstrap = async route => {
      const response = await route.fetch();
      await route.fulfill({response, json: mixedDistribution});
    };
    await page.route('**/api/bootstrap', distributionBootstrap);
    try {
      await page.reload({waitUntil: 'networkidle'}); await visible('.distribution-panel');
      await checkDistribution(mixedDistribution);
    } finally {
      await page.unroute('**/api/bootstrap', distributionBootstrap);
      await page.reload({waitUntil: 'networkidle'});
    }
    assert.deepEqual((await syncApi()).accounts, beforeDistributionScenario.accounts, 'display-only distribution scenario preserves fixture accounts');
    mark('provider distribution includes filtered, unknown and inactive-site accounts and reports counts across currencies');

    const originalAmounts = (await syncApi()).amounts;
    const currencyScenarios = [
      { unit: 'CNY', balance: 234.5, reward: 1.75, balanceText: '¥234.50', rewardText: '¥1.75' },
      { unit: 'credits:fixture-sub2api', balance: 842.5, reward: 7.25, balanceText: '842.50 积分', rewardText: '7.25 积分' },
    ];
    let displayUnit = currencyScenarios[0];
    const singleUnitBootstrap = async route => {
      const scenario = displayUnit;
      const response = await route.fetch();
      const data = await response.json();
      const trend = (data.trend || []).map((point, index, points) => ({ ...point,
        reward: index === points.length - 1 ? scenario.reward : 0,
        runs: index === points.length - 1 ? 1 : 0 }));
      await route.fulfill({ response, json: { ...data,
        amounts: { [scenario.unit]: { balance: scenario.balance, today_reward: scenario.reward } },
        trends: { [scenario.unit]: trend }, trend } });
    };
    await page.route('**/api/bootstrap', singleUnitBootstrap);
    try {
      for (const scenario of currencyScenarios) {
        displayUnit = scenario;
        await page.reload({ waitUntil: 'networkidle' });
        await visible('#currency-picker');
        assert.equal(await page.getByRole('combobox', { name: '切换额度单位' }).inputValue(), scenario.unit);
        await text('.balance-number', scenario.balanceText);
        const claimedReward = page.locator('.metric-card').filter({ has: page.getByText('今日已领取', { exact: true }) });
        assert.ok((await claimedReward.innerText()).includes(scenario.rewardText), 'claimed reward uses the available currency');
        assert.ok(!(await page.locator('.balance-number').innerText()).includes('$'), 'non-USD totals do not display dollar amounts');
      }
    } finally {
      await page.unroute('**/api/bootstrap', singleUnitBootstrap);
      await page.reload({ waitUntil: 'networkidle' });
    }
    assert.deepEqual((await syncApi()).amounts, originalAmounts, 'browser display scenarios leave fixture account data unchanged');
    mark('sole CNY and site-credit units select the available currency and display correct balance/reward values');

    await page.locator('.nav-item[data-view="accounts"]').click();
    await page.locator(`[data-action="edit"][data-id="${any.id}"]`).click();
    await page.locator('#account-form [name="name"]').fill('AnyRouter · Node 已编辑');
    await advancedSettings(); await page.locator('#account-interval').selectOption('12');
    await page.locator('[data-action="toggle-account-enabled"]').click();
    await page.locator('#account-submit').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    state = await syncApi();
    const edited = state.accounts.find(account => account.id === any.id);
    assert.equal(edited.name, 'AnyRouter · Node 已编辑'); assert.equal(edited.interval_hours, 12); assert.equal(edited.enabled, false);
    await shot('accounts-desktop.png');
    mark('account editing, preserved credentials, interval, enabled state and search');

    await page.route('**/api/providers/probe', route => route.fulfill({status: 200, contentType: 'application/json',
      body: JSON.stringify({recognized: false, message: 'Isolated probe fixture', domain: 'https://compatible.example.invalid'})}));
    await page.locator('.nav-item[data-view="sites"]').click();
    await page.locator('[data-action="add-site"]').first().click();
    await page.locator('#site-name').fill('兼容站点 · Node 测试');
    await page.locator('#site-domain').fill('https://compatible.example.invalid');
    await page.locator('#site-template').selectOption('balance');
    await page.locator('#provider-form [type="submit"]').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    state = await syncApi();
    const custom = state.providers.find(provider => provider.name === '兼容站点 · Node 测试');
    assert.ok(custom); assert.equal(custom.sign_in_path, null);
    await page.locator(`[data-action="edit-site"][data-site="${custom.id}"]`).click();
    await page.locator('#site-name').fill('兼容站点 · Node 已更新');
    await page.locator('#provider-form [type="submit"]').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal((await syncApi()).providers.find(provider => provider.id === custom.id).name, '兼容站点 · Node 已更新');
    await page.locator(`[data-action="remove-site"][data-site="${custom.id}"]`).click();
    const removeConfirmation = page.getByRole('alertdialog', {name: '移除自定义站点？', exact: true});
    await removeConfirmation.waitFor({state: 'visible'});
    const failSiteRemoval = route => route.fulfill({status: 503, contentType: 'application/json',
      body: JSON.stringify({detail: '隔离测试：暂时无法移除站点，请重试。'})});
    const removalPath = `**/api/providers/${encodeURIComponent(custom.id)}`;
    await page.route(removalPath, failSiteRemoval);
    try {
      await page.locator('[data-action="confirm-remove-site"]').click();
      await text('#modal [role="alert"]', '暂时无法移除站点');
      assert.equal(await removeConfirmation.isVisible(), true, 'failed removal preserves the confirmation context');
      await until(() => page.locator('[data-action="confirm-remove-site"]').isEnabled(), 'failed removal becomes retryable');
      assert.ok((await syncApi()).providers.some(provider => provider.id === custom.id && provider.active), 'failed removal leaves the site available');
    } finally {
      await page.unroute(removalPath, failSiteRemoval);
    }
    await page.locator('[data-action="confirm-remove-site"]').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.ok(!(await syncApi()).providers.some(provider => provider.id === custom.id && provider.active));
    mark('failed destructive site removal shows an inline error, preserves the site and permits a successful retry');
    await page.unroute('**/api/providers/probe');
    await shot('sites-desktop.png');
    mark('actual provider create/update/remove with isolated public-probe response');

    await page.locator('.nav-item[data-view="overview"]').click();
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-action="modal-switch"]').click();
    await page.locator('#settings-interval').selectOption('12');
    await page.locator('#settings-form [type="submit"]').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal((await syncApi()).settings.scheduler_enabled, true);
    await page.locator('[data-action="settings"]').first().click();
    await page.locator('[data-action="modal-switch"]').click();
    await page.locator('#settings-form [type="submit"]').click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal((await syncApi()).settings.scheduler_enabled, false);
    mark('scheduler settings saved through actual UI/API, with future tasks kept isolated');

    for (const account of [any, agent, sub]) {
      const queued = await api.json(`/api/accounts/${account.id}/run`, {method: 'POST', body: {}});
      assert.equal(queued.queued, true);
      await until(async () => {
        const bootstrap = await api.json('/api/bootstrap');
        const run = bootstrap.runs.find(run => run.account_id === account.id);
        return run && !['running', 'queued'].includes(run.status) ? run : false;
      }, `${account.provider} local background task`, 65000);
    }
    state = await syncApi();
    const runs = id => state.runs.find(run => run.account_id === id);
    assert.equal(runs(any.id).status, 'success'); assert.equal(runs(any.id).reward, 1);
    assert.equal(state.accounts.find(account => account.id === any.id).balance, 51);
    assert.equal(runs(agent.id).status, 'synced'); assert.equal(runs(agent.id).reward, null);
    assert.equal(runs(sub.id).status, 'success'); assert.equal(runs(sub.id).reward, 2.5);
    assert.equal(state.accounts.find(account => account.id === sub.id).balance, 15.25);
    const observed = await fixtureState();
    assert.deepEqual(observed.checkin_posts, {any: 1, agent: 0, sub: 1});
    assert.deepEqual(observed.login_posts, {any: 1, agent: 1, sub: 1});
    assert.deepEqual(observed.forbidden, []);
    mark('real local AnyRouter/Sub2API check-in engines; AgentRouter sync creates no reward/login/check-in');

    await page.locator('.nav-item[data-view="logs"]').click();
    await page.evaluate(() => refresh(true));
    await page.locator('[data-log-filter="synced"]').click();
    await text('.account-table tbody', '奖励未知');
    await page.locator('[data-action="log"]').first().click();
    await text('.log-detail-grid', '奖励未知');
    await page.keyboard.press('Escape');
    await page.locator('[data-log-filter="all"]').click();
    const downloaded = page.waitForEvent('download');
    await page.locator('[data-action="export"]').click();
    const download = await downloaded;
    assert.match(download.suggestedFilename(), /\.csv$/);
    const csvPath = path.join(output, 'fixture-logs.csv'); await download.saveAs(csvPath);
    const csv = await readFile(csvPath, 'utf8');
    assert.ok(csv.includes('AnyRouter') && !Object.values(SECRETS).some(secret => csv.includes(secret)));
    await shot('logs-desktop.png');
    mark('log filters/details distinguish unknown reward; real CSV download contains no credentials');

    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('.nav-item[data-view="overview"]').click();
    await shot('overview-desktop.png');

    for (const view of ['overview', 'accounts', 'sites', 'logs']) {
      await page.setViewportSize({width: 390, height: 844});
      const navigation = page.getByRole('navigation', {name: '工作空间导航'});
      assert.equal(await navigation.count(), 1, 'mobile uses one accessible workspace navigation');
      const target = navigation.locator(`.nav-item[data-view="${view}"]`);
      assert.equal(await target.count(), 1, 'each workspace destination remains unique');
      assert.equal(await target.isVisible(), true);
      await target.focus();
      await page.keyboard.press('Enter');
      assert.equal(await target.getAttribute('aria-current'), 'page');
      assert.equal(new URL(page.url()).hash, `#${view}`);
      await shot(`${view}-mobile.png`);
    }
    mark('one responsive workspace navigation supports keyboard switching across every mobile view');
    await page.setViewportSize({width: 1440, height: 1000});
    const cancelOriginal = await addBrowser('anyrouter', '取消 · 手填表单');
    await page.setViewportSize({width: 390, height: 844});
    await page.locator('#credential-help summary').click(); await shot('manual-entry-mobile.png');
    assert.equal(await page.locator('#account-submit').evaluate(el => {const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}), true);
    await page.locator('#credential-help summary').click(); await shot('manual-import-mobile.png');
    await page.locator('#account-form [name="session"]').fill(SECRETS.any);
    await page.locator('#modal [data-action="close"]').first().click();
    await page.locator('#modal').waitFor({state: 'hidden'});
    assert.equal((await syncApi()).accounts.length, 3);
    assert.equal(cancelOriginal.isClosed(), false);
    const pending = await api.json('/api/login/start', {method: 'POST', body: {provider: 'anyrouter', method: 'manual', name: '旧连接恢复测试', interval_hours: 6, proxy: {mode: 'direct'}}});
    const cancelledConnection = pending.connection;
    await page.reload({waitUntil: 'networkidle'}); await text('#queue-subtitle', '已恢复当前连接');
    await visible('#browser-import-form');
    assert.equal(await page.locator('#local-connector-connect,#connector-copy-button,#optional-browser-extension').count(), 0);
    const descriptor = await api.request(`/api/browser-import/${cancelledConnection.id}`, {auth: false, headers: {Authorization: `Bearer ${cancelledConnection.ticket}`}});
    assert.equal(descriptor.status, 200); assert.equal(descriptor.data.provider.id, 'anyrouter');
    assert.ok(!descriptor.text.includes(cancelledConnection.ticket));
    const cancelButton = await page.locator('[data-action="cancel-login"]').elementHandle();
    await cancelButton.focus();
    await page.evaluate(() => { for (let index = 0; index < 3; index++) renderLoginQueue(state.loginQueue); });
    assert.equal(await cancelButton.evaluate(element => element.isConnected && document.activeElement === element), true, 'unchanged login polling preserves the cancel control and its focus');
    await cancelButton.dispose();
    await page.locator('[data-action="cancel-login"]').click(); await page.locator('#modal').waitFor({state: 'hidden'});
    await until(async () => (await api.request(`/api/browser-import/${cancelledConnection.id}`, {auth: false, headers: {Authorization: `Bearer ${cancelledConnection.ticket}`}})).status === 410, 'cancelled old ticket rejected');
    assert.equal(cancelOriginal.isClosed(), false);
    mark('mobile manual forms, cancellation without save and legacy pending import restores direct fields');

    await page.setViewportSize({width: 1440, height: 1000});
    await page.locator('.nav-item[data-view="accounts"]').click();
    const accountsBeforeCancel = (await syncApi()).accounts;
    const cancelAccount = accountsBeforeCancel.find(account => account.id === any.id);
    for (const cancelMethod of ['escape', 'button']) {
      await page.locator(`[data-action="edit"][data-id="${any.id}"]`).click();
      await page.locator('[data-action="delete"]').click();
      const confirmation = page.getByRole('alertdialog', {name: '删除账号？', exact: true});
      await confirmation.waitFor({state: 'visible'});
      const description = await confirmation.evaluate(element => (element.getAttribute('aria-describedby') || '').split(/\s+/)
        .map(id => document.getElementById(id)?.textContent || '').join(' '));
      assert.ok(description.includes(cancelAccount.name), 'destructive dialog identifies the affected account');
      const cancel = confirmation.getByRole('button', {name: '取消', exact: true});
      assert.equal(await cancel.evaluate(element => document.activeElement === element), true, 'destructive dialog initially focuses the safe action');
      if (cancelMethod === 'escape') await page.keyboard.press('Escape'); else await cancel.click();
      await page.locator('#modal').waitFor({state: 'hidden'});
      assert.deepEqual((await syncApi()).accounts, accountsBeforeCancel, 'canceling deletion preserves the account and credentials');
    }
    mark('account deletion uses a named alertdialog, safe initial focus and cancellation without deleting data');
    for (const account of [any, agent, sub]) {
      await page.locator(`[data-action="edit"][data-id="${account.id}"]`).click();
      await page.locator('[data-action="delete"]').click();
      await page.getByRole('alertdialog', {name: '删除账号？', exact: true}).waitFor({state: 'visible'});
      await page.locator('[data-action="confirm-delete"]').click();
      await page.locator('#modal').waitFor({state: 'hidden'});
    }
    assert.equal((await syncApi()).accounts.length, 0);
    await page.locator('#admin-button').click(); await page.locator('[data-action="logout"]').click();
    await visible('#auth-form');
    assert.equal(await page.locator('#auth-form').getAttribute('data-setup'), 'false');
    assert.equal(await page.locator('#auth-confirm,#setup-token,[name="setup_token"]').count(), 0, 'ordinary login has no setup-only fields');
    assert.equal(await page.locator('#auth-username').inputValue(), '');
    assert.equal(await page.locator('#auth-password').inputValue(), '');
    assert.equal(await page.locator('.auth-form-wrap > h2').innerText(), '登录签到助手');
    await shot('login-desktop.png');
    const rejectedLogin = async (candidateUsername, candidatePassword) => {
      await page.locator('#auth-username').fill(candidateUsername); await page.locator('#auth-password').fill(candidatePassword);
      const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/auth/login' && result.request().method() === 'POST');
      await page.locator('#auth-form [type="submit"]').click();
      assert.equal((await response).status(), 401);
      await expectAuthError('管理员账号或密码不正确。', ['auth-username', 'auth-password']);
      assert.equal((await api.json('/api/auth/status')).authenticated, false);
      assert.equal((await context.cookies(base)).filter(cookie => cookie.name === 'checkin_session').length, 0);
      assert.equal(await page.locator('#workspace-shell').isVisible(), false);
    };
    await rejectedLogin(username === 'wrong-owner' ? 'other-owner' : 'wrong-owner', password);
    await rejectedLogin(username, 'Wrong-Fixture-Password!');
    await page.locator('#auth-password').fill(password);
    const loginResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await page.locator('#auth-form [type="submit"]').click();
    assert.equal((await loginResponse).status(), 200);
    await visible('#workspace-shell');
    await text('#user-name', username); await syncApi();
    assert.equal((await api.json('/api/auth/status')).username, username);
    report.login = {confirmation_absent: true, wrong_username_rejected: true, wrong_password_rejected: true, correct_credentials_accepted: true};
    mark('account deletion, logout and wrong-username/wrong-password/valid login use the configured Node administrator');
    assert.deepEqual(report.javascript_errors, []); assert.deepEqual(report.forbidden_requests, []);
    report.fixture = await fixtureState();
    report.result = 'passed';
    return report;
  } catch (error) {
    report.result = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    await browser.close();
    report.finished_at = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}

export function argumentsFor(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(argv[index].startsWith('--') && argv[index + 1], 'Expected --option value');
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const output = path.resolve(args.output || path.join(ROOT, 'build/test-node-ui'));
  let fixture, processHandle, temporary;
  try {
    let base = args.base;
    let fixtureOrigin = args['fixture-base'];
    let fixtureControl = args['fixture-control'];
    if (!base) {
      assert.ok(existsSync(path.join(ROOT, 'dist-server/main.js')), 'Run npm run build before the UI smoke test');
      temporary = await mkdtemp(path.join(os.tmpdir(), 'checkin-node-ui-'));
      fixture = await startFixture(); fixtureOrigin = fixture.origin; fixtureControl = fixture.control;
      const providersFile = path.join(temporary, 'providers.json');
      await writeFile(providersFile, JSON.stringify(fixture.providers));
      const port = await freePort(); base = `http://127.0.0.1:${port}`;
      processHandle = spawn(process.execPath, ['dist-server/main.js'], {cwd: ROOT,
        env: {...process.env, NODE_ENV: 'test', CHECKIN_HOST: '127.0.0.1', CHECKIN_PORT: String(port),
          CHECKIN_PUBLIC_URL: base, CHECKIN_ADMIN_USER: '', CHECKIN_ADMIN_PASSWORD: '',
          CHECKIN_DATA_DIR: path.join(temporary, 'data'), CHECKIN_TEST_PROVIDERS_FILE: providersFile,
          CHECKIN_MAX_CONCURRENT_RUNS: '1', CHECKIN_PROXY_URL: '', CHECKIN_BROWSER_PATH: browserPath()},
        stdio: ['ignore', 'pipe', 'pipe']});
      let diagnostics = '';
      for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
      processHandle.on('exit', code => { if (code && code !== 0) console.error(`Isolated app exited (${code}): ${diagnostics}`); });
    }
    assert.ok(fixtureOrigin, '--fixture-base is required for an existing isolated app');
    const report = await runUiSmoke({base, fixtureOrigin, fixtureControl, username: args.username || USERNAME,
      password: args.password || PASSWORD, output});
    console.log(JSON.stringify({result: report.result, checks: report.checks.length, screenshots: report.screenshots.length,
      runtime: report.runtime, report: path.join(output, 'report.json')}, null, 2));
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill('SIGTERM');
      await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), delay(8000)]);
      if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
    }
    if (fixture) await fixture.close();
    if (temporary) await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
