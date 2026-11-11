import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeError, CONNECTION_TTL, cookieMatches, hostPattern, normalizeCookie, oauthPatterns, parseConnectionCode, parseDescriptor, positiveUserId, requestedOrigins, safeMessage, secretValue, secureOrigin, targetCookies, upstreamCookies} from '../helpers.mjs';

const NOW = 1794235200000;
const CODE = {version: 1, origin: 'http://127.0.0.1:8766', id: 'fixture_connection_1', ticket: 'FixtureTicket-abcdefghijklmnop'};
const PROVIDER = {id: 'agentrouter', name: 'AgentRouter', domain: 'https://agentrouter.org', login_path: '/login', user_info_path: '/api/user/self', api_user_key: 'new-api-user', template: 'sign_in', waf_cookie_names: ['acw_tc']};
const INFO = {id: CODE.id, status: 'waiting', expires_at: new Date(NOW + 3600000).toISOString(), method: 'github', name: '本地测试', provider: PROVIDER};

test('connection code binds exact HTTPS or local HTTP origin and never accepts URL credentials or paths', () => {
  assert.deepEqual(parseConnectionCode(JSON.stringify(CODE)), CODE);
  assert.equal(secureOrigin('https://assistant.example:9443/'), 'https://assistant.example:9443');
  assert.equal(hostPattern(CODE.origin), 'http://127.0.0.1/*');
  for (const origin of ['http://assistant.example', 'https://user:pass@assistant.example', 'https://assistant.example/path', 'https://assistant.example/?ticket=foo', 'javascript:alert(1)', 'https://assistant.example/#ticket', 'https://assistant.example\\evil']) {
    assert.throws(() => parseConnectionCode(JSON.stringify({...CODE, origin})), BridgeError);
  }
});

test('descriptor locks id, lifetime, method, safe paths and non-reserved request header', () => {
  const descriptor = parseDescriptor(INFO, CODE, NOW);
  assert.equal(descriptor.expiresAt, NOW + CONNECTION_TTL);
  assert.equal(descriptor.provider.domain, PROVIDER.domain);
  for (const changed of [
    {...INFO, id: 'wrong'}, {...INFO, status: 'success'}, {...INFO, expires_at: NOW / 1000 - 1}, {...INFO, method: 'password'},
    {...INFO, provider: {...PROVIDER, domain: CODE.origin}}, {...INFO, provider: {...PROVIDER, user_info_path: '//evil.example/api'}},
    {...INFO, provider: {...PROVIDER, api_user_key: 'cookie'}}, {...INFO, provider: {...PROVIDER, api_user_key: 'sec-fetch-site'}},
    {...INFO, provider: {...PROVIDER, waf_cookie_names: ['session']}},
  ]) assert.throws(() => parseDescriptor(changed, CODE, NOW), BridgeError);
});

test('OAuth origins appear only for explicit AgentRouter and selected identity provider', () => {
  const connection = parseDescriptor(INFO, CODE, NOW);
  assert.deepEqual(requestedOrigins(connection), ['http://127.0.0.1/*', 'https://agentrouter.org/*']);
  assert.deepEqual(oauthPatterns(connection), ['https://github.com/*', 'https://*.github.com/*']);
  assert.deepEqual(oauthPatterns({...connection, method: 'linuxdo'}), ['https://linux.do/*', 'https://*.linux.do/*']);
  assert.deepEqual(oauthPatterns({...connection, provider: {...PROVIDER, id: 'anyrouter'}}), []);
  assert.deepEqual(oauthPatterns({...connection, method: 'manual'}), []);
});

test('cookie exporter normalizes Chromium fields and rejects expired, partitioned, malformed secrets', () => {
  const cookie = {name: 'session', value: 'fixture-secret', domain: '.agentrouter.org', path: '/', expirationDate: NOW / 1000 + 100, httpOnly: true, secure: true, sameSite: 'no_restriction'};
  assert.deepEqual(normalizeCookie(cookie, NOW), {name: 'session', value: 'fixture-secret', domain: '.agentrouter.org', path: '/', expires: NOW / 1000 + 100, httpOnly: true, secure: true, sameSite: 'None'});
  assert.equal(normalizeCookie({...cookie, session: true}, NOW).expires, -1);
  assert.equal(normalizeCookie({...cookie, sameSite: 'unspecified'}, NOW).sameSite, undefined);
  for (const value of ['bad value', 'bad,value', 'bad;value', 'bad\u0080value']) {
    assert.equal(normalizeCookie({...cookie, value}, NOW), null);
    assert.throws(() => secretValue(value), BridgeError);
  }
  for (const changed of [{...cookie, value: 'bad\nvalue'}, {...cookie, expirationDate: NOW / 1000 - 1}, {...cookie, partitionKey: {topLevelSite: 'https://evil.example'}}, {...cookie, name: 'bad;name'}]) assert.equal(normalizeCookie(changed, NOW), null);
});

test('session cookie must match both identity endpoint domain and path', () => {
  const cookie = {name: 'session', value: 'fixture', domain: 'agentrouter.org', path: '/api', session: true, secure: true, hostOnly: true};
  assert.equal(cookieMatches(cookie, 'https://agentrouter.org/api/user/self', NOW), true);
  assert.equal(cookieMatches(cookie, 'https://agentrouter.org/apievil/user/self', NOW), false);
  assert.equal(cookieMatches(cookie, 'http://agentrouter.org/api/user/self', NOW), false);
  assert.equal(cookieMatches(cookie, 'https://evil.agentrouter.org/api/user/self', NOW), false);
});

test('site and upstream cookie exporters exclude unrelated hosts, wrong store and unwanted cookie names', () => {
  const cookies = [
    {name: 'acw_tc', value: 'waf', domain: '.agentrouter.org', path: '/', session: true, storeId: '1'},
    {name: 'session', value: 'site', domain: 'agentrouter.org', path: '/', session: true, storeId: '1'},
    {name: 'acw_tc', value: 'other', domain: 'evil.agentrouter.org', path: '/', session: true, storeId: '1'},
    {name: 'user_session', value: 'github', domain: '.github.com', path: '/', session: true, storeId: '1'},
    {name: 'user_session', value: 'wrong-store', domain: 'github.com', path: '/', session: true, storeId: '2'},
    {name: 'user_session', value: 'unrelated', domain: 'github.com.evil.example', path: '/', session: true, storeId: '1'},
  ];
  assert.deepEqual(targetCookies(cookies, PROVIDER, NOW).map(item => item.value), ['waf']);
  assert.deepEqual(upstreamCookies(cookies, ['github.com'], '1', NOW).map(item => item.value), ['github']);
});

test('identity hints require positive integral ids and unexpected errors never expose raw text', () => {
  assert.equal(positiveUserId(123), '123');
  for (const value of [true, false, 0, -1, 1.5, '01', '1\n', 'bad-secret']) assert.throws(() => positiveUserId(value), BridgeError);
  assert.equal(safeMessage(new Error('private-ticket-and-cookie')), '操作未完成，请检查连接和当前站点后重试。');
});
