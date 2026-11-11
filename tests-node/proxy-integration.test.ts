import assert from 'node:assert/strict';
import { createServer, request as forwardRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { PROVIDERS } from '../server/providers.js';
import { httpRequest, TransportError } from '../server/transport.js';
import type { HttpRequestOptions } from '../server/transport.js';

async function fixture(t: test.TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(handler);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

const defaultUsername = 'fixture-default-proxy-user';
const defaultPassword = 'fixture-default:p@ss/word';
const customUsername = 'fixture-account-proxy-user';
const customPassword = 'fixture-account:p@ss/word';

function defaultConfig(proxy: string) {
  const url = new URL(proxy);
  url.username = defaultUsername;
  url.password = defaultPassword;
  return loadConfig({}, { defaultProxyUrl: url.href });
}

test('real HTTP proxy routes AnyRouter and AgentRouter defaults and isolates account proxy authentication', async t => {
  const siteRequests: { path: string; headers: IncomingHttpHeaders }[] = [];
  const proxyRequests: { url: string; headers: IncomingHttpHeaders }[] = [];
  const site = await fixture(t, (request, response) => {
    siteRequests.push({ path: request.url ?? '', headers: { ...request.headers } });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, via: request.headers['x-fixture-proxy'] ?? 'direct' }));
  });
  const proxy = await fixture(t, (request, response) => {
    proxyRequests.push({ url: request.url ?? '', headers: { ...request.headers } });
    let target: URL;
    try { target = new URL(request.url ?? ''); }
    catch { response.writeHead(400); response.end(); return; }
    // This forwarding fixture is restricted to this test's loopback target.
    if (target.origin !== site || target.username || target.password) {
      response.writeHead(502); response.end(); return;
    }
    const expected = target.pathname === '/any-custom'
      ? basic(customUsername, customPassword) : basic(defaultUsername, defaultPassword);
    if (request.headers['proxy-authorization'] !== expected) {
      response.writeHead(407); response.end(); return;
    }
    const headers: IncomingHttpHeaders = { ...request.headers, 'x-fixture-proxy': 'forwarded' };
    // A forwarding HTTP proxy consumes these headers rather than sending them to the site.
    for (const name of ['proxy-authorization', 'proxy-connection', 'connection']) delete headers[name];
    const upstream = forwardRequest(target, { method: request.method, headers, agent: false }, result => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    });
    upstream.once('error', () => response.destroy());
    request.pipe(upstream);
  });
  const config = defaultConfig(proxy);
  const any = { ...PROVIDERS.anyrouter, domain: site };
  const agent = { ...PROVIDERS.agentrouter, domain: site };
  const cases: { path: string; via: string; options: HttpRequestOptions }[] = [
    { path: '/any-default', via: 'direct', options: { provider: any, proxy: { mode: 'default' } } },
    { path: '/agent-default', via: 'forwarded', options: { provider: agent } },
    { path: '/agent-direct', via: 'direct', options: { provider: agent, proxy: { mode: 'direct' } } },
    { path: '/any-custom', via: 'forwarded', options: { provider: any, proxy: {
      mode: 'custom', server: proxy, authenticate: true, username: customUsername, password: customPassword,
    } } },
  ];
  for (const entry of cases) {
    const result = await httpRequest(site + entry.path, {
      ...entry.options, config, timeoutMs: 2000,
      headers: { Cookie: 'session=fixture-site-session', Authorization: 'Bearer fixture-site-token', 'new-api-user': '7' },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { path: entry.path, via: entry.via });
  }
  assert.deepEqual(proxyRequests.map(request => request.url), [site + '/agent-default', site + '/any-custom']);
  assert.deepEqual(proxyRequests.map(request => request.headers['proxy-authorization']), [
    basic(defaultUsername, defaultPassword), basic(customUsername, customPassword),
  ]);
  assert.deepEqual(siteRequests.map(request => request.path), cases.map(entry => entry.path));
  for (const request of siteRequests) {
    assert.equal(request.headers['proxy-authorization'], undefined);
    assert.equal(request.headers.authorization, 'Bearer fixture-site-token');
    assert.equal(request.headers.cookie, 'session=fixture-site-session');
    assert.equal(request.headers['new-api-user'], '7');
    const observed = JSON.stringify(request);
    for (const secret of [defaultUsername, defaultPassword, customUsername, customPassword,
      basic(defaultUsername, defaultPassword), basic(customUsername, customPassword)]) {
      assert.ok(!observed.includes(secret), 'target must not receive proxy credentials');
    }
  }
});

test('real HTTP proxy authentication refusal returns 407 without retry or direct fallback', async t => {
  let siteRequests = 0;
  const proxyRequests: IncomingHttpHeaders[] = [];
  const site = await fixture(t, (_request, response) => { siteRequests++; response.end('unexpected direct request'); });
  const proxy = await fixture(t, (request, response) => {
    proxyRequests.push({ ...request.headers });
    response.writeHead(407, { 'Content-Type': 'application/json', 'Proxy-Authenticate': 'Basic realm="local-fixture"' });
    response.end('{"error":"fixture-proxy-authentication-required"}');
  });
  const result = await httpRequest(site + '/balance', {
    provider: { ...PROVIDERS.agentrouter, domain: site }, config: defaultConfig(proxy), timeoutMs: 2000,
  });
  assert.equal(result.status, 407);
  assert.deepEqual(result.body, { error: 'fixture-proxy-authentication-required' });
  assert.equal(proxyRequests.length, 1);
  assert.equal(proxyRequests[0]['proxy-authorization'], basic(defaultUsername, defaultPassword));
  assert.equal(siteRequests, 0);
});

test('real HTTP proxy connection failure stays on the selected proxy and sanitizes errors', async t => {
  let siteRequests = 0;
  let proxyRequests = 0;
  const site = await fixture(t, (_request, response) => { siteRequests++; response.end('unexpected direct request'); });
  const proxy = await fixture(t, (request, _response) => { proxyRequests++; request.socket.destroy(); });
  await assert.rejects(httpRequest(site + '/balance?token=fixture-private-query', {
    provider: { ...PROVIDERS.anyrouter, domain: site }, config: defaultConfig(proxy), timeoutMs: 2000,
    proxy: { mode: 'custom', server: proxy, authenticate: true, username: customUsername, password: customPassword },
    headers: { Cookie: 'session=fixture-private-session' },
  }), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.kind, 'network');
    for (const secret of [site, proxy, customUsername, customPassword, basic(customUsername, customPassword),
      'fixture-private-query', 'fixture-private-session']) assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(proxyRequests, 1);
  assert.equal(siteRequests, 0);
});
