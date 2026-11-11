import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridge, inspectSite} from '../bridge.mjs';
import {BridgeError, STORAGE_KEY} from '../helpers.mjs';

const NOW = 1794235200000;
const CODE = {version: 1, origin: 'https://assistant.example:9443', id: 'fixture_connection_1', ticket: 'FixtureTicket-abcdefghijklmnop'};
const PROVIDER = {id: 'agentrouter', name: 'AgentRouter', domain: 'https://agentrouter.org', login_path: '/login', user_info_path: '/api/user/self', api_user_key: 'new-api-user', template: 'sign_in', waf_cookie_names: ['acw_tc']};
const INFO = {id: CODE.id, status: 'waiting', expires_at: new Date(NOW + 600000).toISOString(), method: 'github', name: 'fixture', provider: PROVIDER};

function fixture(options = {}) {
  const storage = {};
  const fetchCalls = [], cookieReads = [], scripts = [], permissionsRemoved = [];
  let getCount = 0;
  const targetCookie = {name: 'session', value: 'target-site-only-secret', domain: 'agentrouter.org', path: '/', session: true, secure: true, httpOnly: true, storeId: 'selected-store'};
  const browser = {
    storage: {session: {get: async key => ({[key]: storage[key]}), set: async data => Object.assign(storage, data), remove: async key => {delete storage[key];}}},
    permissions: {contains: async () => options.permissionDenied !== true, remove: async request => {permissionsRemoved.push(request);}},
    tabs: {
      query: async () => [{id: 7, url: options.tabUrl || 'https://agentrouter.org/console', incognito: !!options.incognito}],
      get: async () => ({id: 7, url: options.changedTabUrl || 'https://agentrouter.org/console'}),
    },
    cookies: {
      getAllCookieStores: async () => [{id: 'selected-store', tabIds: [7]}, {id: 'other-store', tabIds: [8]}],
      get: async request => {
        cookieReads.push(request);
        ++getCount;
        if (options.missingCookie) return null;
        return {...targetCookie, ...(options.sessionChanged && getCount > 1 ? {value: 'new-session'} : {})};
      },
      getAll: async request => {
        cookieReads.push(request);
        if (request.domain) return [
          {name: 'user_session', value: 'github-secret', domain: '.github.com', path: '/', session: true, storeId: 'selected-store'},
          {name: 'user_session', value: 'wrong-store-secret', domain: 'github.com', path: '/', session: true, storeId: 'other-store'},
          {name: 'unrelated', value: 'third-party-secret', domain: 'unrelated.example', path: '/', session: true, storeId: 'selected-store'},
          ...(options.extraOAuthCookies || []).map(item => ({domain: '.github.com', path: '/', session: true, storeId: 'selected-store', ...item})),
        ];
        return [targetCookie, {name: 'acw_tc', value: 'waf', domain: 'agentrouter.org', path: '/', session: true, storeId: 'selected-store'}, {name: 'tracking', value: 'tracker', domain: 'agentrouter.org', path: '/', session: true, storeId: 'selected-store'}, {name: 'acw_tc', value: 'wrong-store-waf', domain: 'agentrouter.org', path: '/', session: true, storeId: 'other-store'}];
      },
    },
    scripting: {executeScript: async request => {
      scripts.push(request);
      return [{frameId: 0, result: {ok: !options.identityFailed, api_user: '123', oauth_user_agent: 'Fixture-User-Agent', session: options.bearer ? 'fixture-bearer-token' : null, refresh_token: options.bearer ? 'fixture-refresh-token' : null}}];
    }},
  };
  const fetcher = async (url, request) => {
    fetchCalls.push({url, ...request});
    if (options.fetchError) throw new Error(`private-${CODE.ticket}-${targetCookie.value}`);
    if (options.httpError) return new Response(JSON.stringify({detail: CODE.ticket + targetCookie.value}), {status: options.httpError});
    const info = options.bearer ? {...INFO, provider: {...PROVIDER, id: 'custom-fixture', template: 'sub2api', user_info_path: '/api/v1/auth/me'}} : INFO;
    return new Response(JSON.stringify(request.method === 'POST' ? {status: 'success', account_id: 1} : info), {headers: {'Content-Type': 'application/json'}});
  };
  return {browser, handle: createBridge(browser, fetcher, () => NOW), storage, fetchCalls, cookieReads, scripts, permissionsRemoved};
}

test('import binds exact helper origin, never sends admin cookies and clears ticket on success', async () => {
  const run = fixture();
  const connected = await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  assert.equal(connected.connection.ticket, undefined);
  assert.equal(run.storage[STORAGE_KEY].ticket, CODE.ticket);
  const result = await run.handle({action: 'import', id: CODE.id, include_oauth: false});
  assert.equal(result.saved, true);
  assert.equal(run.storage[STORAGE_KEY], undefined);
  assert.equal(run.permissionsRemoved.length, 1);
  assert.equal(run.scripts.length, 1);
  assert.equal(run.scripts[0].func, inspectSite);
  assert.deepEqual(run.scripts[0].target, {tabId: 7, frameIds: [0]});
  assert.equal(run.scripts[0].world, 'MAIN');
  for (const request of run.fetchCalls) {
    assert.equal(request.url, `${CODE.origin}/api/browser-import/${CODE.id}`);
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${CODE.ticket}`);
    assert.equal(request.headers.Cookie, undefined);
    assert.equal(request.headers['X-CSRF-Token'], undefined);
    assert.equal(request.url.includes(CODE.ticket), false);
  }
  const post = run.fetchCalls.find(request => request.method === 'POST');
  const payload = JSON.parse(post.body);
  assert.equal(payload.session, 'target-site-only-secret');
  assert.equal(payload.api_user, '123');
  assert.deepEqual(payload.site_cookies.map(cookie => cookie.value), ['waf']);
  assert.deepEqual(payload.oauth_cookies, []);
  assert.equal(run.cookieReads.some(request => request.domain), false);
  assert.equal(run.cookieReads.every(request => request.storeId === 'selected-store'), true);
});

test('OAuth cache requires explicit flag and contains only the selected identity provider and cookie store', async () => {
  const run = fixture();
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  await run.handle({action: 'import', id: CODE.id, include_oauth: true});
  const payload = JSON.parse(run.fetchCalls.find(request => request.method === 'POST').body);
  assert.deepEqual(payload.oauth_cookies.map(cookie => cookie.value), ['github-secret']);
  assert.deepEqual(run.cookieReads.filter(request => request.domain), [{domain: 'github.com', storeId: 'selected-store'}]);
});

test('OAuth consent metadata cannot prevent importing a valid upstream auth cookie', async () => {
  const run = fixture({extraOAuthCookies: [
    {name: 'consent', value: '{"required":true,"analytics":false}'},
    {name: 'display_name', value: 'fixture user'},
    {name: 'locale_hint', value: '测试'},
  ]});
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  const result = await run.handle({action: 'import', id: CODE.id, include_oauth: true});
  assert.equal(result.saved, true);
  const payload = JSON.parse(run.fetchCalls.find(request => request.method === 'POST').body);
  assert.deepEqual(payload.oauth_cookies.map(cookie => cookie.name), ['user_session']);
  assert.deepEqual(payload.oauth_cookies.map(cookie => cookie.value), ['github-secret']);
});

for (const [name, options] of [
  ['unrelated original tab', {tabUrl: 'https://unrelated.example/console'}],
  ['incognito tab', {incognito: true}],
  ['missing session', {missingCookie: true}],
  ['identity query failure', {identityFailed: true}],
  ['changed site session', {sessionChanged: true}],
  ['target navigation before sending', {changedTabUrl: 'https://github.com/login'}],
]) test(`refuses ${name} without uploading credentials`, async () => {
  const run = fixture(options);
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  await assert.rejects(run.handle({action: 'import', id: CODE.id, include_oauth: false}), BridgeError);
  assert.equal(run.fetchCalls.some(request => request.method === 'POST'), false);
  assert.notEqual(run.storage[STORAGE_KEY], undefined);
});

test('wrong connection id cannot import existing ticket', async () => {
  const run = fixture();
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  await assert.rejects(run.handle({action: 'import', id: 'wrong', include_oauth: false}), BridgeError);
  assert.equal(run.cookieReads.length, 0);
});

test('Sub2API imports exact verified token and optional refresh token rather than unrelated cookies', async () => {
  const run = fixture({bearer: true});
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  await run.handle({action: 'import', id: CODE.id, include_oauth: false});
  const payload = JSON.parse(run.fetchCalls.find(request => request.method === 'POST').body);
  assert.equal(payload.session, 'fixture-bearer-token');
  assert.equal(payload.refresh_token, 'fixture-refresh-token');
  assert.equal(run.cookieReads.some(request => request.name === 'session'), false);
});

test('network and server error bodies never expose cookie values or pairing ticket', async () => {
  for (const options of [{fetchError: true}, {httpError: 422}]) {
    const run = fixture(options);
    await assert.rejects(run.handle({action: 'connect', code: JSON.stringify(CODE)}), error => {
      assert.equal(error.message.includes(CODE.ticket), false);
      assert.equal(error.message.includes('target-site-only-secret'), false);
      return error instanceof BridgeError;
    });
  }
});

test('disconnection clears connection and public state carries no ticket', async () => {
  const run = fixture();
  await run.handle({action: 'connect', code: JSON.stringify(CODE)});
  const state = await run.handle({action: 'state'});
  assert.equal(JSON.stringify(state).includes(CODE.ticket), false);
  await run.handle({action: 'disconnect'});
  assert.equal((await run.handle({action: 'state'})).connection, null);
});
