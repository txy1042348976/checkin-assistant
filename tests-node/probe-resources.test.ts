import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import got from 'got';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { BrowserResources } from '../server/browser-resources.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/main.js';
import { probeSite } from '../server/probe.js';

const DOMAIN = 'https://probe-resource-fixture.example';
const config = () => loadConfig({}, { lowMemory: true, testMode: true, browserPath: '/synthetic/chromium' });

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Probe resource fixture did not finish');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function guardedDirectReplies(t: test.TestContext): () => number {
  let requests = 0;
  // All HTTP and browser operations are fixture mocks. The synthetic HTTPS
  // domain satisfies real provider validation without making a network request.
  t.mock.method(got, 'stream', () => {
    requests++;
    const stream = new PassThrough();
    queueMicrotask(() => {
      stream.emit('response', { statusCode: 403, headers: { 'content-type': 'text/html' } });
      stream.end('aliyun_waf: isolated probe fixture');
    });
    return stream as unknown as ReturnType<typeof got.stream>;
  });
  return () => requests;
}

test('a cancelled probe waiting behind a task removes its lease request and never launches later', async t => {
  const requests = guardedDirectReplies(t), resources = new BrowserResources(), controller = new AbortController();
  const releaseTask = await resources.acquire(new AbortController().signal);
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => { launches++; throw new Error('cancelled probe must not launch'); });
  const probing = probeSite(DOMAIN, config(), { signal: controller.signal, browserResources: resources });
  await until(() => resources.queuedCount === 1);
  controller.abort(); const result = await probing;
  assert.equal(result.recognized, false); assert.equal(requests(), 2);
  assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 0);
  releaseTask(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0); assert.equal(resources.activeCount, 0);
});

test('a cancelled late probe launch keeps the next browser out until its browser closes', async t => {
  guardedDirectReplies(t);
  const resources = new BrowserResources(), controller = new AbortController();
  let finishLaunch!: (browser: Browser) => void, finishClose!: () => void, launches = 0, closes = 0, contexts = 0;
  const browser = {
    newContext: async () => { contexts++; throw new Error('cancelled probe must not create a context'); },
    close: () => { closes++; return new Promise<void>(resolve => { finishClose = resolve; }); },
    isConnected: () => true,
  } as unknown as Browser;
  t.mock.method(chromium, 'launch', () => { launches++; return new Promise<Browser>(resolve => { finishLaunch = resolve; }); });
  const probing = probeSite(DOMAIN, config(), { signal: controller.signal, browserResources: resources });
  await until(() => launches === 1);
  controller.abort();
  let nextStarted = false, probeFinished = false;
  void probing.then(() => { probeFinished = true; });
  const next = resources.acquire(new AbortController().signal).then(release => { nextStarted = true; return release; });
  finishLaunch(browser); await until(() => closes === 1);
  assert.equal(nextStarted, false); assert.equal(probeFinished, false);
  assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 1);
  finishClose(); assert.equal((await probing).recognized, false);
  const releaseNext = await next;
  assert.equal(contexts, 0); assert.equal(closes, 1); assert.equal(resources.activeCount, 1);
  releaseNext(); assert.equal(resources.activeCount, 0);
});

test('runtime shutdown waits for a late probe browser to close and rejects new API work', async t => {
  guardedDirectReplies(t);
  let finishLaunch!: (browser: Browser) => void, finishClose!: () => void, launches = 0, closes = 0, contexts = 0;
  const browser = {
    newContext: async () => { contexts++; throw new Error('shutdown probe must not create a context'); },
    close: () => { closes++; return new Promise<void>(resolve => { finishClose = resolve; }); },
    isConnected: () => true,
  } as unknown as Browser;
  t.mock.method(chromium, 'launch', () => { launches++; return new Promise<Browser>(resolve => { finishLaunch = resolve; }); });
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-probe-resource-runtime-'));
  const runtime = await createApp({ config: { ...config(), dataDir: directory, adminPassword: 'Fixture-Secure-2026!' }, startScheduler: false });
  const server = createServer(runtime.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, requestController = new AbortController();
  t.after(async () => {
    requestController.abort(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await runtime.close(); rmSync(directory, { recursive: true, force: true });
  });
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Fixture-Secure-2026!' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const bootstrap = await fetch(origin + '/api/bootstrap', { headers: { cookie } }).then(response => response.json());
  const request = fetch(origin + '/api/providers/probe', { method: 'POST',
    headers: { origin, cookie, 'x-csrf-token': bootstrap.csrf_token, 'content-type': 'application/json' },
    body: JSON.stringify({ domain: DOMAIN }), signal: requestController.signal }).catch(() => null);
  await until(() => launches === 1);
  let finished = false;
  const closing = runtime.close().then(() => { finished = true; });
  const duringShutdown = await fetch(origin + '/api/accounts', { method: 'POST',
    headers: { origin, cookie, 'x-csrf-token': bootstrap.csrf_token, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(duringShutdown.status, 503);
  finishLaunch(browser); await until(() => closes === 1);
  assert.equal(finished, false); assert.equal(runtime.browserResources.activeCount, 1);
  finishClose(); await closing;
  assert.equal(contexts, 0); assert.equal(closes, 1); assert.equal(runtime.browserResources.activeCount, 0);
  requestController.abort(); await request;
});
