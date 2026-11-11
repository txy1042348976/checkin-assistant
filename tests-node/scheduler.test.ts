import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../server/config.js';
import { PROVIDERS } from '../server/providers.js';
import { Scheduler } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import type { RunResult } from '../server/types.js';

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture condition did not finish'); await new Promise(resolve => setImmediate(resolve)); }
}

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'checkin-node-schedule-'));
  const providers = structuredClone(PROVIDERS), config = loadConfig({}, { dataDir: directory, schedulerTickMs: 100000 });
  const store = new Store({ dataDir: directory, providers, timezone: config.timezone });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const add = (name: string) => store.addAccount({ name, provider: 'anyrouter', auth_mode: 'session', enabled: true, interval_hours: 6, session: name + '-private', api_user: '7' });
  return { store, config, add };
}

test('scheduler prevents duplicate starts, caps concurrency and saves real result without exposing credentials', async t => {
  const f = fixture(t), first = f.add('first'), second = f.add('second');
  const completions: ((result: RunResult) => void)[] = [];
  let active = 0, maxActive = 0;
  const engine = { async run() { active++; maxActive = Math.max(maxActive, active); const result = await new Promise<RunResult>(resolve => completions.push(resolve)); active--; return result; }, async close() {} };
  const scheduler = new Scheduler(f.store, engine, { ...f.config, maxConcurrentRuns: 1 });
  t.after(() => scheduler.close());
  scheduler.start();
  assert.equal(scheduler.enqueue(first), true); assert.equal(scheduler.enqueue(first), false); assert.equal(scheduler.enqueue(second), true);
  await until(() => completions.length === 1);
  assert.equal(f.store.runs().length, 1); assert.equal(f.store.account(second)!.status, 'queued');
  completions[0]({ status: 'success', message: '原站已确认', reward: 1, after_balance: 51, used_quota: 10, total_quota: 61 });
  await until(() => completions.length === 2);
  completions[1]({ status: 'synced', message: '仅同步余额', reward: null, after_balance: 20, used_quota: 5, total_quota: 25 });
  await until(() => !scheduler.active.size);
  assert.equal(maxActive, 1); assert.equal(f.store.runs().length, 2); assert.equal(f.store.account(first)!.balance, 51);
  assert.equal(f.store.dashboard().stats.today_reward, 1);
  assert.equal(JSON.stringify(f.store.dashboard()).includes('first-private'), false);
});

test('pending authorization blocks manual and scheduled tasks until it is finished', async t => {
  const f = fixture(t), id = f.add('authorized'); let waiting = true, calls = 0;
  const scheduler = new Scheduler(f.store, { async run() { calls++; return { status: 'synced', message: 'fixture' }; }, async close() {} }, f.config, () => waiting);
  t.after(() => scheduler.close());
  f.store.patch(id, { next_run: new Date(Date.now() - 5000).toISOString() }); scheduler.start();
  assert.equal(scheduler.enqueue(id), false); assert.equal(calls, 0); assert.equal(f.store.runs().length, 0);
  waiting = false; scheduler.tick(); await until(() => calls === 1 && !scheduler.active.size);
  assert.equal(f.store.runs().length, 1); assert.equal(f.store.runs()[0].status, 'synced');
});

test('shutdown aborts an active task and leaves unstarted queue recoverable with honest status', async t => {
  const f = fixture(t), first = f.add('active'), second = f.add('waiting'); let reject!: (error: Error) => void;
  const engine = { async run(): Promise<RunResult> { return new Promise((_resolve, fail) => { reject = fail; }); }, async close() { reject?.(new Error('fixture shutdown')); } };
  const scheduler = new Scheduler(f.store, engine, { ...f.config, maxConcurrentRuns: 1 }); scheduler.start();
  scheduler.enqueue(first); scheduler.enqueue(second); await until(() => typeof reject === 'function');
  await scheduler.close();
  assert.equal(f.store.runs().length, 1); assert.equal(f.store.runs()[0].status, 'interrupted');
  assert.equal(f.store.account(second)!.status, 'queued'); assert.equal(scheduler.enqueue(second), false);
  f.store.recoverInterrupted(); assert.equal(f.store.account(second)!.status, 'idle');
  assert.equal(f.store.account(first)!.status, 'interrupted');
});

test('task failure preserves last balance instead of inventing a successful reward', async t => {
  const f = fixture(t), id = f.add('failure');
  f.store.patch(id, { balance: 42, used_quota: 8, total_quota: 50, has_snapshot: 1 });
  const scheduler = new Scheduler(f.store, { async run() { throw new Error('fixture-sensitive-secret'); }, async close() {} }, f.config);
  t.after(() => scheduler.close()); scheduler.start(); scheduler.enqueue(id);
  await until(() => f.store.runs()[0]?.status === 'failed');
  assert.equal(f.store.account(id)!.balance, 42); assert.equal(f.store.runs()[0].reward, null);
  assert.equal(JSON.stringify(f.store.dashboard()).includes('fixture-sensitive-secret'), false);
});
