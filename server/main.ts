import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { BrowserResources } from './browser-resources.js';
import { ACCOUNT_TRANSFER_PATHS, AccountTransfers, MAX_ACCOUNT_TRANSFER_REQUEST_BYTES } from './account-transfer.js';
import { loadConfig } from './config.js';
import { HttpError, boundedString, integer, isRecord, positiveId, requireRecord } from './errors.js';
import { CheckinEngine, browserAvailable } from './engine.js';
import { MAX_IMPORT_BYTES, UserBrowserImports } from './imports.js';
import { probeSite } from './probe.js';
import { PROVIDERS, loadCustomProviders, parseProviderInput, providerCatalog, providerFromConfig, supports } from './providers.js';
import { normalizeProxy, parseProxyInput } from './proxy.js';
import { Scheduler } from './scheduler.js';
import { WebSecurity } from './security.js';
import { Store } from './store.js';
import type { AccountInput, AccountRow, AppConfig, Provider } from './types.js';

const CREDENTIAL_METHODS = ['password', 'session'];
const MANUAL_IMPORT_FIELDS = new Set(['name', 'provider', 'session', 'api_user', 'refresh_token', 'interval_hours', 'proxy', 'account_id', 'request_id']);

export interface AppRuntime {
  app: Express;
  config: AppConfig;
  store: Store;
  security: WebSecurity;
  accountTransfers: AccountTransfers;
  imports: UserBrowserImports;
  scheduler: Scheduler;
  engine: CheckinEngine;
  browserResources: BrowserResources;
  providers: Record<string, Provider>;
  close(): Promise<void>;
}

function parseAccount(value: unknown, providers: Record<string, Provider>): AccountInput {
  const data = requireRecord(value);
  const provider = boundedString(data.provider, 1, 100), authMode = data.auth_mode ?? 'password';
  if (!CREDENTIAL_METHODS.includes(String(authMode)) || !supports(providers, provider, String(authMode))) throw new HttpError(422, '认证方式或站点无效。');
  const result: AccountInput = { name: boundedString(data.name, 1, 40), provider, auth_mode: authMode as AccountInput['auth_mode'],
    interval_hours: integer(data.interval_hours ?? 6, 1, 168), enabled: data.enabled === undefined ? true : Boolean(data.enabled) };
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw new HttpError(422, '账号启用设置格式无效。');
  for (const [key, max, trim] of [['email', 200, true], ['password', 300, false], ['session', 32000, true], ['api_user', 100, true]] as const) {
    if (data[key] !== undefined && data[key] !== null) result[key] = boundedString(data[key], 0, max, trim);
  }
  if (authMode === 'password' && (!result.email || !result.password)) throw new HttpError(422, '请填写完整的账号与密码。');
  if (authMode === 'session' && (!result.session || !result.api_user)) throw new HttpError(422, '请填写完整的 Session 与用户 ID。');
  return result;
}

function remoteBrowserPath(value: string): boolean { return /^\/(?:api\/)?browser(?:\/|$)/.test(value); }

function testProviders(providers: Record<string, Provider>, config: AppConfig): void {
  if (!config.testMode || !process.env.CHECKIN_TEST_PROVIDERS_FILE) return;
  const definitions = JSON.parse(readFileSync(process.env.CHECKIN_TEST_PROVIDERS_FILE, 'utf8')) as unknown;
  if (!Array.isArray(definitions)) throw new Error('测试站点文件须为数组。');
  for (const definition of definitions) {
    if (!isRecord(definition) || typeof definition.name !== 'string' || typeof definition.domain !== 'string') throw new Error('测试站点定义格式无效。');
    const url = new URL(definition.domain);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', 'host.docker.internal'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('测试站点仅允许本地 HTTP 根网址。');
    const base = providers[definition.name] || { ...providers.anyrouter, name: definition.name, display_name: definition.name,
      custom: true, waf_cookie_names: [], bypass_method: null };
    providers[definition.name] = { ...base, ...definition } as Provider;
  }
}

export async function createApp(options: { config?: AppConfig; providers?: Record<string, Provider>; startScheduler?: boolean } = {}): Promise<AppRuntime> {
  const config = options.config || loadConfig(process.env, { testMode: process.env.NODE_ENV === 'test' });
  const providers = structuredClone(options.providers || PROVIDERS);
  const store = new Store({ dataDir: config.dataDir, providers, timezone: config.timezone });
  const csrf = randomBytes(24).toString('base64url');
  let security: WebSecurity;
  let accountTransfers: AccountTransfers;
  try {
    loadCustomProviders(store.providerConfigs(), providers);
    testProviders(providers, config);
    security = new WebSecurity(store, config, csrf);
    await security.ready;
    accountTransfers = new AccountTransfers(store, providers);
  } catch (error) { store.close(); throw error; }
  const browserResources = new BrowserResources(1);
  const engine = new CheckinEngine({ providers, config, store, browserResources });
  let scheduler: Scheduler;
  const imports = new UserBrowserImports(store, providers, security, config, id => scheduler?.isBusy(id) || false,
    undefined, browserResources, true);
  scheduler = new Scheduler(store, engine, config, id => imports.isAuthorizing(id));
  const probeControllers = new Set<AbortController>();
  const probeTasks = new Set<Promise<unknown>>();
  const app = express();
  let closing = false;
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);
  app.set('trust proxy', config.trustedProxies);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    if (closing && req.path.startsWith('/api/') && req.path !== '/api/health') return next(new HttpError(503, '服务正在重启，请稍后重试。'));
    if (/^\/api\/(?:login|browser-import)(?:\/|$)/i.test(req.path)
      || req.path.toLowerCase() === '/downloads/checkin-assistant-browser-extension.zip') {
      return next(new HttpError(410, '账号连接功能已移除，请在账号表单手动填写并保存。'));
    }
    if (remoteBrowserPath(req.path)) return next(new HttpError(404, '请在账号表单手工填写原站 Session 与用户 ID，或选择账号密码方式。'));
    return security.guard(req, res, next);
  });
  const defaultJson = express.json({ limit: MAX_IMPORT_BYTES, strict: true, verify(req, _res, buffer) {
    const request = req as Request;
    if (request.path?.toLowerCase().startsWith('/api/auth/') && buffer.length > 8192) throw new HttpError(413, '登录请求内容过长。');
  } });
  const transferJson = express.json({ limit: MAX_ACCOUNT_TRANSFER_REQUEST_BYTES, strict: true });
  app.use((req, res, next) => {
    if (req.method === 'POST' && ACCOUNT_TRANSFER_PATHS.has(req.path)) transferJson(req, res, next);
    else defaultJson(req, res, next);
  });
  security.installRoutes(app);

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', runtime: 'node', node: process.version }));
  app.get('/api/bootstrap', (_req, res) => {
    const dashboard = store.dashboard(), catalog = providerCatalog(providers);
    const accountCounts = new Map<string, number>();
    for (const row of dashboard.accounts) accountCounts.set(row.provider, (accountCounts.get(row.provider) ?? 0) + 1);
    for (const provider of catalog) {
      provider.account_count = accountCounts.get(String(provider.id)) ?? 0;
      provider.units_locked = Boolean(provider.account_count || store.db.prepare('SELECT 1 FROM runs WHERE provider=? LIMIT 1').get(String(provider.id)));
    }
    const available = browserAvailable(config);
    res.json({ ...dashboard, csrf_token: csrf, providers: catalog, authorization: null,
      web: { enabled: true, remote_browser: false, authorization_mode: 'manual',
        timezone: config.timezone, max_concurrent_runs: config.maxConcurrentRuns, runtime: 'node' },
      engine: { status: available ? 'ready' : 'browser_required', version: config.version, browser_available: available,
        login_methods: [...CREDENTIAL_METHODS], runtime: 'node' } });
  });

  function editableProvider(id: string): { provider: Provider; rows: AccountRow[] } {
    const provider = providers[id];
    if (!provider || !provider.active) throw new HttpError(404, '站点不存在。');
    if (!provider.custom) throw new HttpError(409, '内置站点不可修改或移除。');
    const rows = store.accounts().filter(row => row.provider === id);
    if (rows.some(row => scheduler.isBusy(row.id) || ['queued', 'running'].includes(row.status)) || imports.providerPending(id)) throw new HttpError(409, '该站点正在排队、签到或保存账号，请结束后再修改。');
    return { provider, rows };
  }

  function duplicateDomain(domain: string, id?: string): void {
    if (Object.entries(providers).some(([key, provider]) => provider.active && provider.domain === domain && key !== id)) throw new HttpError(409, '该网址已存在，请直接在已有站点下添加账号。');
  }

  app.post('/api/providers/probe', async (req, res) => {
    const body = requireRecord(req.body);
    const input = parseProviderInput({ name: '探测', domain: body.domain });
    const controller = new AbortController();
    probeControllers.add(controller);
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    const task = probeSite(input.domain, config, { signal: controller.signal, browserResources });
    probeTasks.add(task);
    try {
      const result = await task;
      if (!res.destroyed && !closing) res.json(result);
    } finally {
      res.off('close', cancel);
      probeTasks.delete(task); probeControllers.delete(controller);
    }
  });
  app.post('/api/providers', (req, res) => {
    const input = parseProviderInput(req.body); duplicateDomain(input.domain);
    const id = 'custom_' + randomUUID().replace(/-/g, '');
    store.saveProvider(id, input); providers[id] = providerFromConfig(id, input);
    res.status(201).json({ id });
  });
  app.put('/api/providers/:id', (req, res) => {
    const id = String(req.params.id), { provider, rows } = editableProvider(id), input = parseProviderInput(req.body);
    duplicateDomain(input.domain, id);
    if (rows.length && provider.domain !== input.domain) throw new HttpError(409, '站点已关联账号，不能更改网址；请新增站点并手动添加账号。');
    const history = store.db.prepare('SELECT 1 FROM runs WHERE provider=? LIMIT 1').get(id);
    if ((rows.length || history) && (provider.currency !== input.currency || provider.quota_per_unit !== input.quota_per_unit)) throw new HttpError(409, '站点已有账号或日志，不能更改额度单位与换算；请新增站点。');
    store.saveProvider(id, input); providers[id] = providerFromConfig(id, input);
    res.json({ ok: true });
  });
  app.delete('/api/providers/:id', (req, res) => {
    const id = String(req.params.id), { rows } = editableProvider(id);
    if (rows.length) throw new HttpError(409, '请先移除该站点下的账号，再移除站点。');
    const record = store.providerConfigs().find(row => row.id === id)!;
    store.saveProvider(id, record.config, false); providers[id] = providerFromConfig(id, record.config, false);
    res.json({ ok: true });
  });

  function transferAuthorization(req: Request, res: Response): () => void {
    const owner = security.adminFingerprint();
    return () => {
      if (closing || req.aborted || res.destroyed || req.socket.destroyed) throw new HttpError(409, '本次备份操作已取消，请重新操作。');
      if (security.adminFingerprint() !== owner) throw new HttpError(401, '登录状态已变化，请重新登录后操作。');
      res.locals.webUser = security.assertRequestAuthorized(req);
    };
  }
  app.post('/api/accounts/export', async (req, res) => {
    const authorization = transferAuthorization(req, res);
    res.json(await accountTransfers.exportBackup(req.body, authorization));
  });
  app.post('/api/accounts/backup/preview', async (req, res) => {
    const authorization = transferAuthorization(req, res);
    res.json(await accountTransfers.previewBackup(req.body, authorization));
  });
  app.post('/api/accounts/backup/import', async (req, res) => {
    const authorization = transferAuthorization(req, res);
    res.json(await accountTransfers.importBackup(req.body, authorization));
  });

  app.post('/api/accounts/import', async (req, res) => {
    const body = requireRecord(req.body);
    if (Object.keys(body).some(key => !MANUAL_IMPORT_FIELDS.has(key))) throw new HttpError(422, '账号导入包含不支持的字段。');
    const provider = boundedString(body.provider, 1, 100);
    if (!supports(providers, provider, 'session')) throw new HttpError(422, '站点不存在或不支持 Session 导入。');
    const name = boundedString(body.name, 1, 40);
    const accountId = body.account_id === undefined || body.account_id === null ? null : positiveId(body.account_id);
    if (typeof body.request_id !== 'string' || !/^[a-f0-9]{32}$/.test(body.request_id)) {
      throw new HttpError(422, '导入请求标识无效，请刷新表单后重试。');
    }
    const credentials = { session: body.session, api_user: body.api_user,
      ...(body.refresh_token === undefined ? {} : { refresh_token: body.refresh_token }) };
    const view = await imports.importManual({ provider, method: 'manual', name, account_id: accountId,
      interval_hours: integer(body.interval_hours ?? 6, 1, 168),
      proxy: body.proxy === undefined || body.proxy === null ? undefined : parseProxyInput(body.proxy),
      origin: security.publicUrl || `${req.protocol}://${req.get('host')}` }, credentials, body.request_id);
    res.status(accountId === null ? 201 : 200).json(view);
  });

  app.post('/api/accounts', (req, res) => {
    const input = parseAccount(req.body, providers); input.proxy = normalizeProxy(requireRecord(req.body).proxy);
    res.status(201).json({ id: store.addAccount(input) });
  });
  app.put('/api/accounts/:id', async (req, res) => {
    const id = positiveId(req.params.id), row = store.account(id), body = requireRecord(req.body);
    if (!row) throw new HttpError(404, '账号不存在。');
    if (body.provider !== undefined && body.provider !== row.provider) throw new HttpError(409, '已有账号不能更改平台，请单独添加账号。');
    if (scheduler.isBusy(id) || ['queued', 'running'].includes(row.status) || imports.isAuthorizing(id)) throw new HttpError(409, '账号正在排队、运行或保存，暂不能编辑。');
    const old = store.credentials(row);
    const merged = { name: body.name ?? row.name, provider: row.provider, auth_mode: body.auth_mode ?? row.auth_mode,
      enabled: body.enabled ?? Boolean(row.enabled), interval_hours: body.interval_hours ?? row.interval_hours, ...old };
    for (const key of ['password', 'session', 'email', 'api_user'] as const) if (body[key]) Object.assign(merged, { [key]: body[key] });
    const input = parseAccount(merged, providers);
    input.proxy = normalizeProxy(body.proxy, old.proxy);
    input.replace_credentials = input.auth_mode !== row.auth_mode || Boolean(body.session || body.api_user);
    if ((body.session || body.api_user) && input.auth_mode === 'session') input.login_via = 'cookie';
    store.updateAccount(id, input);
    if (JSON.stringify(input.proxy) !== JSON.stringify(old.proxy || { mode: 'default' })) await engine.discardBrowserSessions(id);
    res.json({ ok: true });
  });
  app.delete('/api/accounts/:id', async (req, res) => {
    const id = positiveId(req.params.id);
    if (scheduler.isBusy(id) || imports.isAuthorizing(id) || !store.deleteAccount(id)) throw new HttpError(409, '账号不存在或正在排队、执行任务、保存。');
    await engine.discardBrowserSessions(id); res.json({ ok: true });
  });
  app.post('/api/accounts/:id/run', (req, res) => {
    const id = positiveId(req.params.id);
    if (!store.account(id)) throw new HttpError(404, '账号不存在。');
    if (imports.isAuthorizing(id)) throw new HttpError(409, '该账号正在保存，暂不能运行任务。');
    const queued = scheduler.enqueue(id); res.status(202).json({ queued, ...(!queued ? { message: '该账号已在队列、运行或保存中。' } : {}) });
  });
  app.post('/api/run-all', (_req, res) => res.status(202).json({ queued: store.accounts(true).reduce((total, row) => total + Number(scheduler.enqueue(row.id)), 0) }));
  app.patch('/api/settings', (req, res) => {
    const body = requireRecord(req.body);
    if (typeof body.scheduler_enabled !== 'boolean') throw new HttpError(422, '调度设置格式无效。');
    store.updateSettings(body.scheduler_enabled, integer(body.interval_hours, 1, 168)); res.json({ ok: true });
  });
  app.get('/api/logs/export', (_req, res) => {
    const lines: unknown[][] = [['时间', '账号', '平台', '状态', '触发方式', '签到前', '签到后', '额度变化', '说明', '额度单位']];
    for (const row of store.runs(1000)) lines.push([row.started_at, row.account_name, row.provider, row.status, row.trigger,
      row.before_balance, row.after_balance, row.reward, row.message, row.currency]);
    const cell = (value: unknown) => {
      let text = value === null || value === undefined ? '' : String(value);
      if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=checkin-assistant-logs.csv' })
      .send('\ufeff' + lines.map(line => line.map(cell).join(',')).join('\r\n') + '\r\n');
  });
  app.use('/assets', express.static(path.join(config.resourceRoot, 'web'), { dotfiles: 'deny', redirect: false, fallthrough: false }));
  app.use((req, res, next) => {
    const routePath = req.path.toLowerCase();
    if (routePath === '/api' || routePath.startsWith('/api/') || remoteBrowserPath(routePath) || routePath.startsWith('/downloads/')) return next(new HttpError(404, '页面或接口不存在。'));
    if (req.method !== 'GET' && req.method !== 'HEAD') return next(new HttpError(405, '请求方式不受支持。'));
    res.sendFile(path.join(config.resourceRoot, 'web', 'index.html'));
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    if (error instanceof HttpError) {
      if (error.headers) res.set(error.headers);
      res.status(error.status).json({ detail: error.message, ...(error.fields ? { fields: error.fields } : {}) });
    } else if (isRecord(error) && error.type === 'entity.too.large') res.status(413).json({ detail: '请求内容过长。' });
    else if (error instanceof SyntaxError || (isRecord(error) && error.type === 'entity.parse.failed')) res.status(400).json({ detail: '请求内容格式无效。' });
    else if (isRecord(error) && error.status === 404) res.status(404).json({ detail: '页面或资源不存在。' });
    else res.status(500).json({ detail: '请求未完成，请稍后重试。' });
  });
  if (options.startScheduler !== false) scheduler.start();
  let closeTask: Promise<void> | undefined;
  return { app, config, store, security, accountTransfers, imports, scheduler, engine, browserResources, providers, close() {
    closing = true;
    if (!closeTask) closeTask = (async () => {
      browserResources.shutdown();
      for (const controller of probeControllers) controller.abort();
      try { await Promise.allSettled([imports.close(), scheduler.close(), ...probeTasks]); }
      finally { store.close(); }
    })();
    return closeTask;
  } };
}

export async function startServer(config = loadConfig(process.env, { testMode: process.env.NODE_ENV === 'test' })): Promise<{ server: http.Server; runtime: AppRuntime }> {
  const runtime = await createApp({ config, startScheduler: false });
  const server = http.createServer(runtime.app);
  server.requestTimeout = 60_000; server.headersTimeout = 15_000;
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(config.port, config.host, () => { server.off('error', failed); resolve(); });
    });
    runtime.scheduler.start();
  } catch (error) {
    server.closeAllConnections(); server.close(); await runtime.close(); throw error;
  }
  return { server, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { server, runtime } = await startServer();
    console.log(`[签到助手] Node.js ${process.version}，监听 ${runtime.config.host}:${runtime.config.port}`);
    let stopping = false;
    const stop = async () => {
      if (stopping) return; stopping = true;
      const force = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 20_000); force.unref();
      server.close();
      try { await runtime.close(); } finally { clearTimeout(force); server.closeAllConnections(); }
    };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  } catch (error) {
    console.error(error instanceof HttpError ? error.message : '签到助手启动失败，请检查 Node.js 版本、数据目录权限和配置。');
    process.exitCode = 1;
  }
}
