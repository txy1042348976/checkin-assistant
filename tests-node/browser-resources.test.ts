import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import test from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { BrowserResources } from '../server/browser-resources.js';
import { loadConfig } from '../server/config.js';
import { BrowserSession } from '../server/engine.js';
import { PROVIDERS } from '../server/providers.js';
import { TransportError } from '../server/transport.js';

const isAborted = (error: unknown): boolean => error instanceof TransportError && error.kind === 'aborted';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Browser resource fixture did not finish');
    await new Promise(resolve => setImmediate(resolve));
  }
}

function browserSession(resources: BrowserResources, signal = new AbortController().signal): BrowserSession {
  return new BrowserSession(structuredClone(PROVIDERS.anyrouter),
    loadConfig({}, { lowMemory: true, testMode: true, browserPath: '/synthetic/chromium' }), null, signal, resources);
}

test('browser budget grants in order and removes a cancelled waiter without using its slot', async () => {
  const resources = new BrowserResources(), firstSignal = new AbortController(), cancelled = new AbortController(), thirdSignal = new AbortController();
  const first = await resources.acquire(firstSignal.signal);
  const second = assert.rejects(resources.acquire(cancelled.signal), isAborted);
  let thirdStarted = false;
  const third = resources.acquire(thirdSignal.signal).then(release => { thirdStarted = true; return release; });
  assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 2);
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 1);
  cancelled.abort(); await second;
  assert.equal(resources.queuedCount, 1); assert.equal(thirdStarted, false);
  assert.equal(getEventListeners(cancelled.signal, 'abort').length, 0);
  first(); const releaseThird = await third;
  assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 0);
  assert.equal(getEventListeners(thirdSignal.signal, 'abort').length, 0);
  first(); assert.equal(resources.activeCount, 1, 'a repeated release cannot over-admit browsers');
  releaseThird(); assert.equal(resources.activeCount, 0);
});

test('shutdown cancels queued launches, rejects new work and preserves the active lease until cleanup', async () => {
  const resources = new BrowserResources(), controller = new AbortController();
  const release = await resources.acquire(controller.signal);
  const waiter = new AbortController(), waiting = assert.rejects(resources.acquire(waiter.signal), isAborted);
  resources.shutdown(); await waiting;
  assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 0);
  assert.equal(getEventListeners(waiter.signal, 'abort').length, 0);
  await assert.rejects(resources.acquire(new AbortController().signal), isAborted);
  release(); assert.equal(resources.activeCount, 0);
  resources.close();
});

test('an already cancelled launch never consumes a browser resource', async () => {
  const resources = new BrowserResources(), controller = new AbortController();
  controller.abort(); await assert.rejects(resources.acquire(controller.signal), isAborted);
  assert.equal(resources.activeCount, 0); assert.equal(resources.queuedCount, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a queued BrowserSession cancellation never launches Chromium later', async t => {
  const resources = new BrowserResources(), release = await resources.acquire(new AbortController().signal), controller = new AbortController();
  let launches = 0;
  t.mock.method(chromium, 'launch', async () => { launches++; throw new Error('must not launch'); });
  const session = browserSession(resources, controller.signal), starting = assert.rejects(session.start({}), isAborted);
  await until(() => resources.queuedCount === 1);
  controller.abort(); await starting; await session.close(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 0); assert.equal(resources.activeCount, 0); assert.equal(resources.queuedCount, 0);
});

test('a failed Chromium launch releases its resource for the next caller', async t => {
  const resources = new BrowserResources();
  t.mock.method(chromium, 'launch', async () => { throw new Error('synthetic launch failure'); });
  const session = browserSession(resources);
  await assert.rejects(session.start({}), /synthetic launch failure/);
  await session.close();
  assert.equal(resources.activeCount, 0);
  const release = await resources.acquire(new AbortController().signal); release();
});

test('ordinary mode keeps its existing browser behavior without acquiring the small-memory budget', async t => {
  const resources = new BrowserResources(), release = await resources.acquire(new AbortController().signal);
  let launches = 0, closes = 0;
  const browser = {
    newContext: async () => { throw new Error('synthetic ordinary-mode context setup'); },
    close: async () => { closes++; }, isConnected: () => true,
  } as unknown as Browser;
  t.mock.method(chromium, 'launch', async () => { launches++; return browser; });
  const session = new BrowserSession(structuredClone(PROVIDERS.anyrouter),
    loadConfig({}, { lowMemory: false, testMode: true, browserPath: '/synthetic/chromium' }), null, new AbortController().signal, resources);
  await assert.rejects(session.start({}), /synthetic ordinary-mode context setup/); await session.close();
  assert.equal(launches, 1); assert.equal(closes, 1); assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 0);
  release();
});

test('cancelling a late launch retains its slot until the late browser finishes closing', async t => {
  const resources = new BrowserResources();
  let finishLaunch!: (browser: Browser) => void, finishClose!: () => void, closes = 0, contexts = 0, launches = 0;
  const lateBrowser = {
    newContext: async () => { contexts++; throw new Error('must not create context'); },
    close: () => { closes++; return new Promise<void>(resolve => { finishClose = resolve; }); },
    isConnected: () => true,
  } as unknown as Browser;
  t.mock.method(chromium, 'launch', () => { launches++; return new Promise<Browser>(resolve => { finishLaunch = resolve; }); });
  const session = browserSession(resources), starting = assert.rejects(session.start({}), isAborted);
  await until(() => launches === 1);
  const closing = session.close();
  let nextAdmitted = false;
  const next = resources.acquire(new AbortController().signal).then(release => { nextAdmitted = true; return release; });
  finishLaunch(lateBrowser); await until(() => closes === 1);
  assert.equal(nextAdmitted, false); assert.equal(resources.activeCount, 1); assert.equal(resources.queuedCount, 1);
  finishClose(); await Promise.all([closing, starting]); const releaseNext = await next;
  assert.equal(contexts, 0); assert.equal(closes, 1); assert.equal(resources.activeCount, 1);
  releaseNext(); assert.equal(resources.activeCount, 0);
});

test('a failed close keeps the browser budget occupied until the browser really disconnects', async t => {
  const resources = new BrowserResources(), events = new EventEmitter();
  let connected = true;
  const browser = Object.assign(events, {
    newContext: async () => { throw new Error('synthetic context setup failure'); },
    close: async () => { throw new Error('synthetic close failure'); },
    isConnected: () => connected,
  }) as unknown as Browser;
  t.mock.method(chromium, 'launch', async () => browser);
  const session = browserSession(resources);
  await assert.rejects(session.start({}), /synthetic context setup failure/);
  await assert.rejects(session.close(), (error: unknown) => error instanceof TransportError && error.kind === 'network');
  assert.equal(resources.activeCount, 1);
  let nextAdmitted = false;
  const next = resources.acquire(new AbortController().signal).then(release => { nextAdmitted = true; return release; });
  assert.equal(nextAdmitted, false);
  connected = false; events.emit('disconnected'); const releaseNext = await next;
  assert.equal(resources.activeCount, 1); releaseNext(); assert.equal(resources.activeCount, 0);
});
