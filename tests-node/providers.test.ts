import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpError } from '../server/errors.js';
import { PROVIDERS, loadCustomProviders, parseProviderInput, providerCatalog, providerFromConfig, supports } from '../server/providers.js';
import { normalizeProxy, parseProxyInput, publicProxy, resolveProxy } from '../server/proxy.js';
import { profileId, profileSnapshot, responseData, resolveCustomProtocol, ProtocolMismatch } from '../server/protocols.js';
import { classifyConfig, chooseProbeResult } from '../server/probe.js';
import type { AccountRow, ProviderInput } from '../server/types.js';

const input = (overrides = {}) => ({ name: '合成站点', domain: 'https://fixture.example', ...overrides });
const invalid = (error: unknown) => error instanceof HttpError && error.status === 422;

test('built-in catalog preserves Any explicit check-in, Agent login reward and WAF/proxy behavior', () => {
  assert.equal(PROVIDERS.anyrouter.sign_in_path, '/api/user/sign_in');
  assert.deepEqual(PROVIDERS.anyrouter.waf_cookie_names, ['acw_tc', 'cdn_sec_tc', 'acw_sc__v2']);
  assert.equal(PROVIDERS.agentrouter.sign_in_path, null); assert.equal(PROVIDERS.agentrouter.use_proxy, true);
  const catalog = providerCatalog();
  assert.deepEqual(catalog.map(site => site.id), ['anyrouter', 'agentrouter']);
  assert.equal(supports(PROVIDERS, 'anyrouter', 'github'), true);
  assert.equal(supports(PROVIDERS, '__proto__', 'session'), false);
});

test('custom templates use correct protocol paths, units, headers and balance-only behavior', () => {
  const newApi = parseProviderInput(input());
  assert.equal(newApi.sign_in_path, '/api/user/checkin'); assert.equal(newApi.user_info_path, '/api/user/self'); assert.equal(newApi.quota_per_unit, 500000);
  const signIn = parseProviderInput(input({ template: 'sign_in' })); assert.equal(signIn.sign_in_path, '/api/user/sign_in');
  const sub = parseProviderInput(input({ template: 'sub2api' }));
  assert.equal(sub.login_api_path, '/api/v1/auth/login'); assert.equal(sub.user_info_path, '/api/v1/auth/me');
  assert.equal(sub.sign_in_path, '/api/v1/user/check-in'); assert.equal(sub.quota_per_unit, 1);
  for (const template of ['balance', 'sub2api_balance']) assert.equal(parseProviderInput(input({ template, sign_in_path: '/other/path' })).sign_in_path, null);
  const custom = parseProviderInput(input({ currency: 'CNY', quota_per_unit: 1000, api_user_key: 'X-Fixture-User', user_info_path: '/account/profile' }));
  assert.equal(custom.currency, 'CNY'); assert.equal(custom.api_user_key, 'x-fixture-user');
  assert.equal(custom.user_info_path, '/account/profile');
});

test('provider validation rejects credentials, unsafe paths, auth headers and malformed protocol hints', () => {
  for (const domain of ['http://fixture.example', 'https://user:private@fixture.example', 'https://fixture.example/path', 'https://fixture.example?q=private',
    'https://fixture.example#fragment', 'https://fixture.example\\redirect', 'https://fixture%2eexample', 'https://fixture..example']) {
    assert.throws(() => parseProviderInput(input({ domain })), invalid);
  }
  for (const path of ['//elsewhere.example', '/api/../login', '/api/self?token=private', '/api/%2fself', '/api/self#private', 'api/self']) {
    assert.throws(() => parseProviderInput(input({ user_info_path: path })), invalid);
  }
  for (const header of ['cookie', 'authorization', 'host', 'content-type', 'sec-fetch-site', 'proxy-authorization', 'x-private\r\nCookie']) {
    assert.throws(() => parseProviderInput(input({ api_user_key: header })), invalid);
  }
  for (const fields of [{ quota_per_unit: NaN }, { quota_per_unit: true }, { quota_per_unit: 0 }, { template: 'generic' }, { currency: 'EUR' }, { token: 'private' }]) {
    assert.throws(() => parseProviderInput(input(fields)), invalid);
  }
});

test('custom provider loading is isolated and cannot replace reserved built-ins', () => {
  const first = structuredClone(PROVIDERS), second = structuredClone(PROVIDERS), config = parseProviderInput(input());
  loadCustomProviders([{ id: 'fixture', config, active: false }, { id: 'anyrouter', config, active: true }], first);
  assert.equal(first.fixture.active, false); assert.equal(second.fixture, undefined);
  assert.equal(first.anyrouter.domain, PROVIDERS.anyrouter.domain);
  assert.equal(supports(first, 'fixture', 'session'), false);
  loadCustomProviders([], first); assert.equal(first.fixture, undefined);
});

test('proxy normalization preserves explicit default ports and authentication without publishing credentials', () => {
  assert.equal(parseProxyInput({ mode: 'custom', server: 'http://proxy.example:80' }).server, 'http://proxy.example:80');
  assert.equal(parseProxyInput({ mode: 'custom', server: 'https://proxy.example:443' }).server, 'https://proxy.example:443');
  assert.equal(parseProxyInput({ mode: 'custom', server: 'socks5://[::1]:1080' }).server, 'socks5://[::1]:1080');
  const original = normalizeProxy({ mode: 'custom', server: 'http://proxy.example:8080', authenticate: true, username: 'fixture-user', password: 'fixture-password' });
  const updated = normalizeProxy({ mode: 'custom', server: original.server, authenticate: true }, original);
  assert.equal(updated.password, 'fixture-password');
  assert.deepEqual(publicProxy(updated), { mode: 'custom', server: original.server, has_auth: true });
  assert.throws(() => normalizeProxy({ mode: 'custom', server: 'http://changed.example:8080', authenticate: true }, original), invalid);
  assert.deepEqual(normalizeProxy({ mode: 'direct' }, original), { mode: 'direct' });
  const legacy = publicProxy({ mode: 'custom', server: 'http://fixture-user:fixture-password@proxy.example:8080' });
  assert.equal(legacy.server, original.server); assert.equal(legacy.has_auth, true);
  assert.equal(JSON.stringify(legacy).includes('fixture-password'), false);
});

test('proxy routing uses only selected provider/config and rejects invalid or unsupported auth', () => {
  const app = { defaultProxyUrl: 'http://fixture-user:fixture-password@proxy.example:8080' };
  assert.equal(resolveProxy(PROVIDERS.anyrouter, { mode: 'default' }, app), null);
  assert.equal(resolveProxy(PROVIDERS.agentrouter, { mode: 'direct' }, app), null);
  assert.equal(resolveProxy(PROVIDERS.agentrouter, { mode: 'default' }, app)?.username, 'fixture-user');
  for (const server of ['http://proxy.example', 'http://user:private@proxy.example:80', 'ftp://proxy.example:80', 'http://proxy.example:0',
    'http://proxy.example:65536', 'http://proxy.example:80/path', 'http://proxy.example:80?private', 'http://proxy.example:80#private']) {
    assert.throws(() => parseProxyInput({ mode: 'custom', server }), invalid);
  }
  assert.throws(() => normalizeProxy({ mode: 'custom', server: 'socks5://proxy.example:1080', authenticate: true, username: 'u', password: 'p' }), invalid);
});

test('money snapshots require actual finite protocol fields and never fabricate missing totals', () => {
  const newApi = providerFromConfig('fixture', input());
  assert.deepEqual(profileSnapshot({ quota: 6_250_000, used_quota: 1_250_000 }, newApi), { balance: 12.5, used_quota: 2.5, total: 15 });
  for (const profile of [{ quota: 0 }, { quota: 100, used_quota: NaN }, { quota: true, used_quota: 0 }, { quota: -1, used_quota: 0 }, { quota: '100', used_quota: 0 }]) {
    assert.equal(profileSnapshot(profile, newApi), null);
  }
  const sub = providerFromConfig('fixture', input({ template: 'sub2api' }));
  assert.deepEqual(profileSnapshot({ balance: -5, quota: 0, used_quota: 0 }, sub), { balance: -5, used_quota: null, total: null });
  assert.equal(profileSnapshot({ quota: 0, used_quota: 0 }, sub), null);
  assert.equal(responseData({ success: true, data: { id: 7 } }, sub), null);
  assert.equal(responseData({ code: false, data: { id: 7 } }, sub), null);
  for (const id of [true, 0, -1, NaN, 1.5, '0', '0007', 'sk-private']) assert.equal(profileId(id), null);
  assert.equal(profileId('123456789012345678901234567890'), '123456789012345678901234567890');
});

test('public site probing accepts strict contracts, honors disabled check-in and rejects protocol conflicts', () => {
  const domain = 'https://fixture.example';
  const standard = classifyConfig(domain, '/api/status', { success: true, data: { system_name: 'fixture', checkin_enabled: true, quota_per_unit: 1000 } })!;
  assert.equal(standard.template, 'newapi'); assert.equal(standard.defaults!.quota_per_unit, 1000);
  assert.equal(classifyConfig(domain, '/api/status', { success: true, data: { system_name: 'fixture', checkin_enabled: false } })!.template, 'balance');
  assert.equal(classifyConfig(domain, '/api/status', { success: true, data: { system_name: 'fixture' } }, true)!.template, 'sign_in');
  const sub = classifyConfig(domain, '/api/v1/settings/public', { code: 0, data: { site_name: 'fixture', check_in_enabled: false } })!;
  assert.equal(sub.protocol, 'sub2api'); assert.equal(sub.template, 'balance'); assert.equal(sub.defaults!.user_info_path, '/api/v1/auth/me');
  assert.equal(sub.defaults!.sign_in_path, null); assert.equal(sub.defaults!.quota_per_unit, 1);
  assert.equal(chooseProbeResult([standard, sub])!.recognized, false);
  for (const body of [{ code: true, data: { site_name: 'fixture', registration_enabled: true } }, { code: 0, data: { site_name: 'fixture' } },
    { success: true, data: { checkin_enabled: true } }, { success: 'true', data: { system_name: 'fixture' } }]) {
    assert.equal(classifyConfig(domain, body.code !== undefined ? '/api/v1/settings/public' : '/api/status', body), null);
  }
});

test('automatic Sub2API protocol correction only changes untouched sites with no recorded money', () => {
  const parsed = parseProviderInput(input()), registry = { fixture: providerFromConfig('fixture', parsed) };
  let saved: ProviderInput | undefined;
  const store = { providerConfigs: () => [{ id: 'fixture', config: parsed, active: true }], accounts: () => [] as AccountRow[],
    saveProvider: (_id: string, value: ProviderInput) => { saved = value; }, runs: () => [] };
  const resolved = resolveCustomProtocol(registry.fixture, { protocol: 'sub2api' }, store, registry);
  assert.equal(resolved.template, 'sub2api'); assert.equal(saved!.quota_per_unit, 1);
  const customized = providerFromConfig('fixture', { ...parsed, user_info_path: '/custom/profile' });
  assert.throws(() => resolveCustomProtocol(customized, { protocol: 'sub2api' }, store, { fixture: customized }), ProtocolMismatch);
  const untouched = providerFromConfig('fixture', parsed);
  assert.throws(() => resolveCustomProtocol(untouched, { protocol: 'sub2api' }, store, { fixture: untouched }, true), ProtocolMismatch);
});
