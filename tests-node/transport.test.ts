import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { HttpError } from '../server/errors.js';
import { PROVIDERS } from '../server/providers.js';
import { httpRequest, safeRequestUrl, TransportError } from '../server/transport.js';

async function fixture(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('transport preserves JSON and separate Set-Cookie headers with Expires commas', async t => {
  const site = await fixture(t, (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.headers['content-type'], 'application/json');
    res.writeHead(200, { 'Content-Type': 'application/problem+json', 'Set-Cookie': ['one=fixture; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/', 'two=fixture; Path=/'] });
    res.end(JSON.stringify({ success: true }));
  });
  const response = await httpRequest(site + '/api', { method: 'POST', json: { action: 'synthetic' } });
  assert.deepEqual(response.body, { success: true }); assert.equal(response.status, 200);
  assert.equal(response.headers['set-cookie'].split('\n').length, 2);
  assert.match(response.headers['set-cookie'], /Wed, 21 Oct/);
});

test('transport never follows redirects, retries POST or trusts non-JSON bodies', async t => {
  let requests = 0;
  const site = await fixture(t, (req, res) => {
    requests++;
    if (req.url === '/post') { res.writeHead(503, { Location: '/unexpected', 'Content-Type': 'text/html' }); res.end('{"success":true}'); }
    else { res.writeHead(302, { Location: '/unexpected' }); res.end(); }
  });
  const redirect = await httpRequest(site + '/start'); assert.equal(redirect.status, 302); assert.equal(requests, 1);
  const post = await httpRequest(site + '/post', { method: 'POST', json: {} });
  assert.equal(post.status, 503); assert.equal(post.body, null); assert.equal(requests, 2);
});

test('transport caps decompressed response bytes instead of trusting compressed content length', async t => {
  const compressed = gzipSync('x'.repeat(100_000));
  const site = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': compressed.length }); res.end(compressed);
  });
  await assert.rejects(httpRequest(site, { maxBytes: 5000 }), (error: unknown) => error instanceof TransportError && error.kind === 'limit');
});

test('transport timeout and cancellation sanitize errors without reflecting credentials or response data', async t => {
  const site = await fixture(t, () => {});
  await assert.rejects(httpRequest(site + '/private?token=fixture-private', { timeoutMs: 50, headers: { Cookie: 'session=fixture-private' } }),
    (error: unknown) => error instanceof TransportError && error.kind === 'timeout' && !error.message.includes('fixture-private'));
  const controller = new AbortController(), request = httpRequest(site, { signal: controller.signal }); controller.abort();
  await assert.rejects(request, (error: unknown) => error instanceof TransportError && error.kind === 'aborted');
});

test('a completed transport releases its abort listener before a later phase is cancelled', async t => {
  let requests = 0;
  const site = await fixture(t, (_req, res) => { requests++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  const controller = new AbortController();
  assert.deepEqual((await httpRequest(site, { signal: controller.signal })).body, { ok: true });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
});

test('transport rejects cross-origin targets, header injection and read-only payloads before sending', async t => {
  let requests = 0;
  const site = await fixture(t, (_req, res) => { requests++; res.end(); });
  for (const value of ['http://user:private@fixture.example', 'http://fixture.example#private', 'http://fixture.example\\redirect', 'http://fixture.example/with space']) {
    assert.throws(() => safeRequestUrl(value), HttpError);
  }
  const provider = { ...PROVIDERS.anyrouter, domain: site };
  assert.throws(() => safeRequestUrl('http://elsewhere.example', provider), HttpError);
  await assert.rejects(httpRequest(site, { headers: { Cookie: 'session=private\r\nInjected: yes' } }), HttpError);
  await assert.rejects(httpRequest(site, { method: 'GET', json: { private: true } }), HttpError);
  await assert.rejects(httpRequest(site, { maxBytes: 8 * 1024 * 1024 + 1 }), HttpError);
  assert.equal(requests, 0);
});

test('transport ignores ambient proxy environment for a direct provider request', async t => {
  const site = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"direct":true}'); });
  const previous = process.env.HTTP_PROXY; process.env.HTTP_PROXY = 'http://fixture-user:fixture-password@127.0.0.1:1';
  t.after(() => { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; });
  assert.deepEqual((await httpRequest(site)).body, { direct: true });
});
