import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the real browser script with a controlled network and clock. Rendering
// is covered by ui-smoke; these cases exercise scheduling and late responses
// without a second Chromium process or real account/site requests.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const initialTime = Date.parse('2026-11-11T09:10:00Z');
const dashboard = () => ({
  accounts: [{ id: 1, name: 'Synthetic account', provider: 'anyrouter', enabled: true, status: 'idle', balance: 2, next_run: '2026-11-11T10:00:00Z' }],
  runs: [], settings: { scheduler_enabled: true, interval_hours: 6 }, stats: { balance: 2, today_completed: 0 },
  amounts: { USD: { balance: 2, today_reward: 0 } }, trends: { USD: [] }, trend: [],
  providers: [{ id: 'anyrouter', name: 'AnyRouter' }], web: { enabled: true, timezone: 'Asia/Shanghai', authorization_mode: 'manual' },
  engine: { version: 'fixture' }, csrf_token: 'synthetic-csrf', authorization: null,
});

interface Pending {
  path: string;
  method: string;
  signal?: AbortSignal;
  settled: boolean;
  respond(body: unknown, status?: number): void;
}

async function flush(): Promise<void> {
  // Response.json() and async functions cross several microtask boundaries.
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function fixture() {
  let now = initialTime, timerId = 0;
  const timers = new Map<number, { due: number; callback: () => unknown }>();
  const listeners = new Map<string, (() => unknown)[]>();
  const pending: Pending[] = [];
  const elements = new Map<string, any>();
  const timeElement = { dataset: { runTime: '2026-11-11T10:00:00Z' }, textContent: '' };
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, open: false, dataset: {}, textContent: '', innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, reset() {}, close() { this.open = false; },
    });
    return elements.get(selector);
  };
  const listen = (type: string, callback: () => unknown) => listeners.set(type, [...(listeners.get(type) || []), callback]);
  const document = {
    visibilityState: 'visible',
    querySelector: element,
    querySelectorAll: (selector: string) => selector === '[data-run-time]' ? [timeElement] : [],
    addEventListener: listen,
  };
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const sandbox: any = {
    document, window: { addEventListener: listen }, location: { hash: '' },
    console, Date: ClockDate, URL, AbortController, Response, WeakMap, CSS: { escape: (value: string) => value },
    setTimeout(callback: () => unknown, delay = 0) { const id = ++timerId; timers.set(id, { due: now + delay, callback }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    fetch(path: string, options: RequestInit) {
      return new Promise<Response>(resolve => {
        const request: Pending = {
          path, method: options.method || 'GET', signal: options.signal ?? undefined, settled: false,
          respond(body, status = 200) {
            assert.equal(request.settled, false, 'a controlled response is only completed once');
            request.settled = true;
            // Deliberately allow a response after abort: browsers can already
            // have received it, so epoch protection must stand independently.
            resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
          },
        };
        pending.push(request);
      });
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'web/app.js' });
  vm.runInContext(`
    globalThis.renderCount=0;
    render=()=>{renderCount++;};
    syncAccountTransfer=()=>{};
    disposeAccountTransfer=()=>{};
    renderAuth=()=>{$('#auth-screen').hidden=false;$('#workspace-shell').hidden=true;};
  `, context);
  const evaluate = <T = any>(code: string): T => vm.runInContext(code, context);
  const next = (path = '/api/bootstrap') => {
    const request = pending.find(request => !request.settled && request.path === path);
    assert.ok(request, `pending request exists for ${path}`);
    return request;
  };
  const respond = async (body: unknown, status = 200, path = '/api/bootstrap') => { next(path).respond(body, status); await flush(); };
  await respond({ authenticated: true, configured: true, username: 'synthetic-owner' }, 200, '/api/auth/status');
  await respond(dashboard());
  const advance = async (milliseconds: number) => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.due <= now && timers.delete(id)) timer.callback();
    }
    await flush();
  };
  const visibility = async (value: string) => {
    document.visibilityState = value;
    for (const callback of listeners.get('visibilitychange') || []) callback();
    await flush();
  };
  const emit = async (type: string) => { for (const callback of listeners.get(type) || []) callback(); await flush(); };
  return { evaluate, pending, next, respond, advance, visibility, emit, timers, elements, timeElement,
    refreshDelay: () => evaluate<number>('refreshDelay()'), renders: () => evaluate<number>('renderCount') };
}

test('workspace polls slowly while idle, quickly during a queued/running task and stops while hidden', async () => {
  const f = await fixture();
  assert.equal(f.refreshDelay(), 30000);
  await f.advance(29999);
  assert.equal(f.pending.length, 2);
  await f.advance(1);
  const busy = dashboard(); busy.accounts[0].status = 'queued';
  await f.respond(busy);
  assert.equal(f.refreshDelay(), 5000);
  await f.advance(5000);
  busy.accounts[0].status = 'running'; await f.respond(busy);
  assert.equal(f.refreshDelay(), 5000);
  await f.visibility('hidden');
  const before = f.pending.length;
  await f.advance(120000);
  await f.evaluate('refresh(true)');
  assert.equal(f.pending.length, before);
  assert.equal(f.timers.size, 0);
  await f.visibility('visible');
  assert.equal(f.pending.length, before + 1, 'returning to the page starts an immediate read');
  await f.respond(dashboard());
  assert.equal(f.refreshDelay(), 30000);
});

test('actions finishing during a stale bootstrap read await one merged follow-up with the new state', async () => {
  const f = await fixture();
  const first = f.evaluate<Promise<void>>('refresh(true)');
  const stale = f.next();
  const mutation = f.evaluate<Promise<unknown>>("api('/api/settings',{method:'PATCH',body:{scheduler_enabled:false,interval_hours:6}})");
  await f.respond({ ok: true }, 200, '/api/settings');
  await mutation;
  let actionsFinished = false;
  const action = f.evaluate<Promise<void>>('refresh(true)').then(() => { actionsFinished = true; });
  const otherAction = f.evaluate<Promise<void>>('refresh(true)');
  stale.respond(dashboard()); await flush();
  assert.equal(actionsFinished, false, 'mutation caller waits for its subsequent read');
  assert.equal(f.pending.filter(request => request.path === '/api/bootstrap').length, 3);
  const updated = dashboard(); updated.settings.scheduler_enabled = false;
  await f.respond(updated);
  await Promise.all([first, action, otherAction]);
  assert.equal(actionsFinished, true);
  assert.equal(f.evaluate('state.data.settings.scheduler_enabled'), false);
  assert.equal(f.pending.filter(request => request.path === '/api/bootstrap').length, 3, 'multiple completed actions merge into one follow-up');
});

test('automatic polling shares an in-flight read without creating another follow-up', async () => {
  const f = await fixture();
  const first = f.evaluate<Promise<void>>('refresh(true)');
  const poll = f.evaluate<Promise<void>>('refresh(true,{background:true})');
  await f.respond(dashboard());
  await Promise.all([first, poll]);
  assert.equal(f.pending.filter(request => request.path === '/api/bootstrap').length, 2);
});

test('unchanged display data preserves rendering while CSRF and authorization clock fields still update', async () => {
  const f = await fixture();
  const request = f.evaluate<Promise<void>>('refresh(true)');
  const unchanged = { ...dashboard(), csrf_token: 'rotated-synthetic-token', authorization: { id: 'synthetic-authorization', elapsed: 23 } };
  await f.respond(unchanged); await request;
  assert.equal(f.renders(), 1);
  assert.equal(f.evaluate('state.data.csrf_token'), 'rotated-synthetic-token');
  assert.equal(f.evaluate('state.data.authorization.elapsed'), 23);
  const changed = dashboard(); changed.accounts[0].balance = 3;
  const refresh = f.evaluate<Promise<void>>('refresh(true)'); await f.respond(changed); await refresh;
  assert.equal(f.renders(), 2, 'a real displayed balance change renders');
});

test('minute clock updates only countdown text, without rebuilding the workspace or fetching data', async () => {
  const f = await fixture();
  f.evaluate('clearTimeout(refreshTimer);refreshTimer=null;updateRunTimes()');
  assert.equal(f.timeElement.textContent, '50 分钟后');
  const requests = f.pending.length;
  await f.advance(60000);
  assert.equal(f.timeElement.textContent, '49 分钟后');
  assert.equal(f.renders(), 1);
  assert.equal(f.pending.length, requests);
});

test('network failures back off up to two minutes and recovery restores the idle cadence', async () => {
  const f = await fixture();
  for (const expected of [5000, 10000, 20000, 40000, 80000, 120000, 120000]) {
    const refresh = f.evaluate<Promise<void>>('refresh(true)');
    await f.respond({ detail: 'Synthetic network failure' }, 503); await refresh;
    assert.equal(f.refreshDelay(), expected);
  }
  const recovered = f.evaluate<Promise<void>>('refresh(true)');
  await f.respond(dashboard()); await recovered;
  assert.equal(f.refreshDelay(), 30000);
});

test('logout aborts pending bootstrap work and rejects a late success without restoring account data', async () => {
  const f = await fixture();
  const oldRefresh = f.evaluate<Promise<void>>('refresh(true)'), old = f.next();
  const logout = f.evaluate<Promise<void>>('logout()');
  await f.respond({ ok: true }, 200, '/api/auth/logout'); await logout;
  assert.equal(old.signal?.aborted, true);
  old.respond(dashboard()); await oldRefresh;
  assert.equal(f.evaluate('state.data'), null);
  assert.equal(f.evaluate('state.auth.authenticated'), false);
  assert.equal(f.renders(), 1);
  assert.equal(f.timers.size, 0);
});

test('a late unauthorized response from an older login cannot log out a newly authenticated workspace', async () => {
  const f = await fixture();
  const oldRefresh = f.evaluate<Promise<void>>('refresh(true)'), old = f.next();
  f.evaluate("resetRefresh();state.auth={authenticated:true,username:'new-owner'};state.data=null");
  const newRefresh = f.evaluate<Promise<void>>('refresh(false)');
  old.respond({ detail: 'Old session expired' }, 401); await oldRefresh;
  await f.respond(dashboard()); await newRefresh;
  assert.equal(f.evaluate('state.auth.username'), 'new-owner');
  assert.equal(f.evaluate('state.auth.authenticated'), true);
  assert.equal(f.pending.filter(request => request.path === '/api/auth/status').length, 1);
  assert.equal(f.renders(), 2);
});

test('a late old-session auth status cannot replace a login completed while returning to the login screen', async () => {
  const f = await fixture();
  const oldRefresh = f.evaluate<Promise<void>>('refresh(true)');
  await f.respond({ detail: 'Synthetic expired session' }, 401);
  const oldStatus = f.next('/api/auth/status');
  f.evaluate("resetRefresh();state.auth={authenticated:true,username:'new-owner'};state.data=null");
  const newRefresh = f.evaluate<Promise<void>>('refresh(false)');
  oldStatus.respond({ authenticated: false, configured: true, username: null });
  await oldRefresh;
  await f.respond(dashboard()); await newRefresh;
  assert.equal(f.evaluate('state.auth.username'), 'new-owner');
  assert.equal(f.evaluate('state.auth.authenticated'), true);
});

test('hashchange after immediate navigation does not render the already selected view twice', async () => {
  const f = await fixture();
  f.evaluate("state.view='accounts';location.hash='#accounts';render()");
  const before = f.renders();
  await f.emit('hashchange');
  assert.equal(f.renders(), before);
  f.evaluate("location.hash='#logs'");
  await f.emit('hashchange');
  assert.equal(f.evaluate('state.view'), 'logs');
  assert.equal(f.renders(), before + 1);
});
