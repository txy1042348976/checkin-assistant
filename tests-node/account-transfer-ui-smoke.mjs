import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { ApiClient, PASSWORD, ROOT, argumentsFor, freePort, ready, until } from './ui-smoke.mjs';

const BACKUP_PASSWORD = 'Fixture-Account-Backup-2026!';
const CREDENTIALS = {
  any: 'isolated-transfer-any-session',
  agent: 'Isolated-Agent-Transfer-Password!',
  second: 'Isolated-Second-Transfer-Password!',
  imported: 'isolated-transfer-imported-session',
};

function browserPath() {
  const options = [process.env.CHECKIN_BROWSER_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'];
  const executable = options.find(candidate => candidate && existsSync(candidate));
  assert.ok(executable, 'Install system Chrome/Chromium for isolated UI verification');
  return executable;
}

export async function runAccountTransferUiSmoke({ base, password = PASSWORD, output }) {
  assert.notEqual(new URL(base).port, '8766', 'This smoke must not use the live local preview');
  await mkdir(output, { recursive: true });
  const report = { result: 'running', started_at: new Date().toISOString(), checks: [], screenshots: [],
    javascript_errors: [], forbidden_requests: [], outbound_business_requests: [] };
  const mark = name => { report.checks.push(name); console.log(`${name}: passed`); };
  report.runtime = await ready(base);
  const api = new ApiClient(base);
  const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  const origin = new URL(base).origin;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin && url.protocol !== 'blob:') { report.forbidden_requests.push(url.origin); return route.abort(); }
    if (/^\/api\/(?:run-all|login\/start|accounts\/\d+\/run)$/.test(url.pathname)) report.outbound_business_requests.push(url.pathname);
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.javascript_errors.push(error.message));
  page.on('websocket', socket => report.forbidden_requests.push(socket.url()));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) report.javascript_errors.push(message.text());
  });
  const visible = selector => page.locator(selector).waitFor({ state: 'visible' });
  const text = (selector, value) => until(async () => (await page.locator(selector).innerText()).includes(value), `${selector} text`);
  const shot = async name => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name);
    if (await page.locator('#modal').isVisible()) {
      assert.ok(await page.locator('#modal').evaluate(element => element.scrollWidth <= element.clientWidth), name);
      const actions = page.locator('.transfer-actions .button:visible').last();
      if (await actions.count()) assert.ok(await actions.evaluate(element => {
        const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight;
      }), `${name}: actions stay in the viewport`);
    }
    const filename = path.join(output, name);
    await page.screenshot({ path: filename, fullPage: true, animations: 'disabled' });
    report.screenshots.push(filename);
  };
  const syncApi = async () => {
    api.cookie = (await context.cookies(base)).filter(cookie => cookie.name === 'checkin_session').map(cookie => `${cookie.name}=${cookie.value}`).join(';');
    return api.json('/api/bootstrap');
  };
  const file = value => ({ name: 'isolated-account-backup.json', mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)) });
  const openImport = async () => { await page.locator('[data-action="accounts-import"]').click(); await visible('#account-import-form'); };
  const selectFile = async value => {
    await page.getByLabel('账号备份文件', { exact: true }).setInputFiles(file(value));
    await until(() => page.locator('#account-import-preview-submit').isEnabled(), 'file ready');
  };
  const preview = async () => {
    await page.locator('#account-import-preview-submit').click();
    await visible('#account-import-preview');
    await until(() => page.locator('#account-import-preview-submit').isEnabled(), 'preview finished');
  };
  const download = async action => {
    const pending = page.waitForEvent('download'); await action();
    const result = await pending;
    const downloadPath = await result.path();
    assert.ok(downloadPath);
    return { filename: result.suggestedFilename(), json: JSON.parse(await readFile(downloadPath, 'utf8')) };
  };
  const close = async () => { await page.locator('#modal [data-action="close"]').first().click(); await page.locator('#modal').waitFor({ state: 'hidden' }); };
  const safePreview = async () => {
    const content = await page.locator('#account-import-preview').innerText();
    for (const secret of [...Object.values(CREDENTIALS), BACKUP_PASSWORD, 'fixture-transfer-username', 'fixture-transfer-second']) assert.ok(!content.includes(secret));
  };
  const seeded = [];
  let initialIds = [];
  let cleanupAllowed = false;
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await visible('#auth-form');
    await page.getByLabel('登录账号', { exact: true }).fill('admin');
    await page.getByLabel('登录密码', { exact: true }).fill(password);
    await page.locator('#auth-form [type="submit"]').click();
    await visible('#workspace-shell');
    const initial = await syncApi();
    assert.equal(initial.accounts.length, 0, 'The account transfer smoke requires an empty isolated app');
    initialIds = initial.accounts.map(account => account.id);
    cleanupAllowed = true;
    await api.json('/api/settings', { method: 'PATCH', body: { scheduler_enabled: false, interval_hours: 6 } });
    await page.locator('.nav-item[data-view="accounts"]').click();
    assert.equal(await page.locator('[data-action="accounts-export"]').isEnabled(), false);
    await openImport();
    assert.equal(await page.locator('#account-import-preview-submit').isEnabled(), false);
    let exportCalls = 0;
    const exportCounter = request => { if (new URL(request.url()).pathname === '/api/accounts/export') exportCalls++; };
    page.on('request', exportCounter);
    const sample = await download(() => page.locator('#account-import-template').click());
    assert.equal(sample.filename, 'checkin-assistant-accounts-example.json');
    assert.equal(sample.json.format, 'checkin-assistant-accounts');
    assert.deepEqual(sample.json.accounts.map(account => account.provider), ['anyrouter', 'agentrouter']);
    assert.equal(exportCalls, 0, 'The sample is client-only');
    page.off('request', exportCounter);
    await shot('account-import-empty-laptop.png'); await close();
    mark('empty account page provides import and a client-only editable example; export is disabled');

    for (const account of [
      { name: '迁移 · AnyRouter', provider: 'anyrouter', auth_mode: 'session', session: CREDENTIALS.any, api_user: '7', enabled: true, interval_hours: 12 },
      { name: '迁移 · AgentRouter', provider: 'agentrouter', auth_mode: 'password', email: 'fixture-transfer-username', password: CREDENTIALS.agent, enabled: false, interval_hours: 6 },
      { name: '迁移 · 另一个 Agent', provider: 'agentrouter', auth_mode: 'password', email: 'fixture-transfer-second', password: CREDENTIALS.second, enabled: true, interval_hours: 24 },
    ]) seeded.push((await api.json('/api/accounts', { method: 'POST', body: account })).id);
    await page.reload({ waitUntil: 'networkidle' }); await visible('.account-management-head');
    await page.locator('[data-action="accounts-export"]').click();
    assert.equal(await page.locator('[data-export-format="encrypted"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#account-export-submit').click();
    await text('#account-export-form [role="alert"]', '8 至 1024');
    await page.getByLabel('备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await page.getByLabel('确认备份密码', { exact: true }).fill('Different-Fixture-Password!');
    await page.locator('#account-export-submit').click();
    await text('#account-export-form [role="alert"]', '不一致');
    await page.getByLabel('确认备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await shot('account-export-encrypted-laptop.png');
    const encrypted = await download(() => page.locator('#account-export-submit').click());
    assert.match(encrypted.filename, /^checkin-assistant-accounts-\d{4}-\d{2}-\d{2}\.encrypted\.json$/);
    assert.equal(encrypted.json.format, 'checkin-assistant-accounts-encrypted');
    assert.ok(!Object.values(CREDENTIALS).some(secret => JSON.stringify(encrypted.json).includes(secret)));
    await page.locator('#modal').waitFor({ state: 'hidden' });
    mark('encrypted export uses password confirmation and downloads a protected backup without showing credentials');

    await page.locator('#account-search').fill('AnyRouter');
    await page.locator('[data-action="accounts-export"]').click();
    await page.getByLabel('导出范围', { exact: true }).selectOption('filtered');
    await text('#account-export-count', '1 个账号');
    await page.locator('[data-export-format="plain"]').click();
    assert.equal(await page.locator('#account-export-passwords').isVisible(), false);
    const selected = await download(() => page.locator('#account-export-submit').click());
    assert.equal(selected.json.accounts.length, 1); assert.equal(selected.json.accounts[0].name, '迁移 · AnyRouter');
    assert.equal(selected.json.accounts[0].credentials.session, CREDENTIALS.any);
    assert.ok(!JSON.stringify(selected.json).includes(CREDENTIALS.agent));
    await page.locator('#modal').waitFor({ state: 'hidden' });
    await page.locator('#account-search').fill('');
    await page.locator('[data-action="accounts-export"]').click();
    await page.locator('[data-export-format="plain"]').click();
    const plain = await download(() => page.locator('#account-export-submit').click());
    assert.equal(plain.json.accounts.length, 3);
    await page.locator('#modal').waitFor({ state: 'hidden' });
    mark('plain JSON export honors the current provider/search filter and also supports all accounts');

    await openImport(); await selectFile(encrypted.json);
    assert.equal(await page.locator('#account-import-password-field').isVisible(), true);
    await page.getByLabel('备份密码', { exact: true }).fill('Wrong-Fixture-Backup!');
    await page.locator('#account-import-preview-submit').click();
    await visible('#account-import-form [role="alert"]');
    assert.equal(await page.locator('#account-import-password').inputValue(), 'Wrong-Fixture-Backup!');
    assert.equal(await page.locator('#account-import-file').evaluate(input => input.files.length), 1);
    await page.getByLabel('备份密码', { exact: true }).fill(BACKUP_PASSWORD); await preview();
    assert.equal(await page.locator('#account-import-submit').isEnabled(), false);
    await text('#account-import-preview', '无需重复导入'); await safePreview();
    assert.equal((await syncApi()).accounts.length, 3);
    await shot('account-import-duplicates-laptop.png'); await close();
    assert.equal(await page.locator('#account-import-password').inputValue(), '');
    assert.equal(await page.locator('#account-import-file').evaluate(input => input.files.length), 0);
    mark('encrypted import handles a wrong password, preserves inputs and previews duplicates without credentials');

    const mixed = { ...plain.json, accounts: [
      plain.json.accounts[0],
      { name: '导入 · Any 新账号', provider: 'anyrouter', auth_mode: 'session', enabled: true, interval_hours: 3,
        credentials: { session: CREDENTIALS.imported, api_user: '99', proxy: { mode: 'direct' } } },
      { name: '导入 · Agent 新账号', provider: 'agentrouter', auth_mode: 'password', enabled: true, interval_hours: 12,
        credentials: { email: 'fixture-transfer-new-login', password: 'Isolated-New-Agent-Password!' } },
    ] };
    mixed.accounts.push(structuredClone(mixed.accounts[1]));
    const invalid = structuredClone(mixed); invalid.accounts.push({ ...mixed.accounts[2], name: '' });
    await openImport(); await selectFile(invalid); await preview();
    await text('#account-import-preview', '需修正');
    assert.equal(await page.locator('#account-import-submit').isEnabled(), false);
    await safePreview(); await shot('account-import-invalid-laptop.png');
    assert.equal((await syncApi()).accounts.length, 3);
    await selectFile(mixed); assert.equal(await page.locator('#account-import-preview').isVisible(), false); await preview();
    await text('#account-import-submit', '2 个账号');
    await page.getByLabel('恢复文件中的自动运行设置', { exact: true }).check();
    assert.equal(await page.locator('#account-import-preview').isVisible(), false);
    await page.getByLabel('恢复文件中的自动运行设置', { exact: true }).uncheck(); await preview();
    await shot('account-import-preview-laptop.png');
    mark('plain import previews mixed new, existing and in-file duplicate accounts and blocks invalid rows');

    const attempts = [];
    let loseReply = true;
    const retryRoute = async route => {
      attempts.push(route.request().postDataJSON().request_id);
      if (loseReply) { loseReply = false; await route.fetch(); await route.abort('failed'); }
      else await route.continue();
    };
    await context.route('**/api/accounts/backup/import', retryRoute);
    await page.locator('#account-import-submit').click(); await visible('#account-import-form [role="alert"]');
    assert.equal(await page.locator('#account-import-file').evaluate(input => input.files.length), 1);
    await page.locator('#account-import-submit').click(); await page.locator('#modal').waitFor({ state: 'hidden' });
    await context.unroute('**/api/accounts/backup/import', retryRoute);
    assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]);
    const imported = await syncApi(); assert.equal(imported.accounts.length, 5);
    const added = imported.accounts.filter(account => !seeded.includes(account.id));
    assert.equal(added.length, 2); assert.ok(added.every(account => account.enabled === false && account.balance === null && account.status === 'idle'));
    mark('lost successful import reply retries with the same nonce, creates no duplicates and leaves new tasks paused');

    await openImport();
    const invalidInputs = [
      file('{not-json'), file({ format: 'checkin-assistant-accounts', version: 999, accounts: [] }),
      { name: 'wrong.csv', mimeType: 'text/csv', buffer: Buffer.from('name,provider') },
      { name: 'too-large.json', mimeType: 'application/json', buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 32) },
    ];
    for (const input of invalidInputs) {
      await page.getByLabel('账号备份文件', { exact: true }).setInputFiles(input);
      await visible('#account-import-form [role="alert"]');
      assert.equal(await page.locator('#account-import-preview-submit').isEnabled(), false);
    }
    await close();
    mark('malformed JSON, unsupported versions, wrong extensions and oversized files remain local and cannot be submitted');

    await openImport(); await selectFile(mixed);
    let pendingPreviewResolve, releasePreview;
    const pendingPreview = new Promise(resolve => { pendingPreviewResolve = resolve; });
    const previewRelease = new Promise(resolve => { releasePreview = resolve; });
    const slowPreviewRoute = async route => {
      const response = await route.fetch(); pendingPreviewResolve(); await previewRelease;
      try { await route.fulfill({ response }); } catch { /* Closing aborts the obsolete request. */ }
    };
    await context.route('**/api/accounts/backup/preview', slowPreviewRoute);
    await page.locator('#account-import-preview-submit').click(); await pendingPreview;
    await close(); await openImport(); releasePreview();
    await context.unroute('**/api/accounts/backup/preview', slowPreviewRoute);
    assert.equal(await page.locator('#account-import-preview').isVisible(), false);
    assert.equal(await page.locator('#account-import-file').evaluate(input => input.files.length), 0);
    await close();
    mark('closing a pending preview clears file/password state and ignores its delayed reply');

    await page.evaluate(() => {
      const original = File.prototype.text;
      window.transferOriginalFileText = original;
      window.transferHeldFileRead = new Promise(resolve => { window.transferReleaseRead = resolve; });
      File.prototype.text = async function () {
        if (this.name === 'slow-file.json') await window.transferHeldFileRead;
        return original.call(this);
      };
    });
    await openImport();
    await page.getByLabel('账号备份文件', { exact: true }).setInputFiles({ ...file(mixed), name: 'slow-file.json' });
    await page.getByLabel('账号备份文件', { exact: true }).setInputFiles(file('{broken-json'));
    await visible('#account-import-form [role="alert"]');
    await page.evaluate(() => { window.transferReleaseRead(); File.prototype.text = window.transferOriginalFileText; });
    assert.equal(await page.locator('#account-import-preview-submit').isEnabled(), false);
    await close();
    mark('a delayed file read cannot replace a newer invalid file or re-enable its import controls');

    await page.setViewportSize({ width: 390, height: 844 });
    await shot('account-transfer-accounts-mobile.png'); await openImport(); await shot('account-import-empty-mobile.png');
    const many = { ...plain.json, accounts: Array.from({ length: 25 }, (_, index) => ({ name: `批量账号 ${index + 1}`, provider: 'agentrouter', auth_mode: 'password',
      enabled: true, interval_hours: 6, credentials: { email: `isolated-mobile-${index}`, password: 'Isolated-Mobile-Fixture-Password!' } })) };
    await selectFile(many); await preview(); await shot('account-import-preview-mobile.png'); await close();
    await page.locator('[data-action="accounts-export"]').click();
    await page.getByLabel('备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await page.getByLabel('确认备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await shot('account-export-encrypted-mobile.png'); await close();
    await page.setViewportSize({ width: 1366, height: 768 });
    mark('mobile import/export controls and long previews fit the viewport with reachable actions');

    let downloadCount = 0;
    const downloadCounter = () => { downloadCount++; };
    page.on('download', downloadCounter);
    await page.locator('[data-action="accounts-export"]').click();
    await page.getByLabel('备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await page.getByLabel('确认备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    const failExport = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '隔离测试：暂时无法生成备份。' }) });
    await context.route('**/api/accounts/export', failExport);
    await page.locator('#account-export-submit').click(); await visible('#account-export-form [role="alert"]');
    assert.equal(downloadCount, 0); assert.equal(await page.locator('#account-export-password').inputValue(), BACKUP_PASSWORD);
    await context.unroute('**/api/accounts/export', failExport); await close();
    await page.locator('[data-action="accounts-export"]').click();
    await page.getByLabel('备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    await page.getByLabel('确认备份密码', { exact: true }).fill(BACKUP_PASSWORD);
    const expireExport = route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: '请重新登录。' }) });
    await context.route('**/api/accounts/export', expireExport);
    await page.locator('#account-export-submit').click(); await visible('#auth-form');
    assert.equal(await page.locator('#modal').isVisible(), false); assert.equal(await page.locator('#account-export-password').inputValue(), '');
    assert.equal(downloadCount, 0); await context.unroute('**/api/accounts/export', expireExport); page.off('download', downloadCounter);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
    mark('failed export creates no download; expired authorization clears passwords and returns to login');

    assert.deepEqual(report.javascript_errors, []); assert.deepEqual(report.forbidden_requests, []); assert.deepEqual(report.outbound_business_requests, []);
    report.result = 'passed';
    return report;
  } catch (error) {
    report.result = 'failed'; report.failure = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    try {
      if (cleanupAllowed && api.cookie) {
        const current = await api.json('/api/bootstrap');
        for (const account of current.accounts.filter(account => !initialIds.includes(account.id))) await api.json(`/api/accounts/${account.id}`, { method: 'DELETE', body: {} });
      }
    } finally {
      await browser.close(); report.finished_at = new Date().toISOString();
      await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
}

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const output = path.resolve(args.output || path.join(ROOT, 'build/test-node-account-transfer-ui'));
  let temporary, processHandle;
  try {
    assert.ok(!args.base, 'Use the exported runner only for an existing isolated app; CLI always creates fresh data');
    assert.ok(existsSync(path.join(ROOT, 'dist-server/main.js')), 'Run npm run build before UI verification');
    temporary = await mkdtemp(path.join(os.tmpdir(), 'checkin-account-transfer-ui-'));
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    processHandle = spawn(process.execPath, ['dist-server/main.js'], { cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'test', CHECKIN_HOST: '127.0.0.1', CHECKIN_PORT: String(port),
        CHECKIN_PUBLIC_URL: base, CHECKIN_ADMIN_USER: 'admin', CHECKIN_ADMIN_PASSWORD: PASSWORD,
        CHECKIN_DATA_DIR: path.join(temporary, 'data'), CHECKIN_TEST_PROVIDERS_FILE: '', CHECKIN_PROXY_URL: '',
        CHECKIN_BROWSER_PATH: browserPath(), CHECKIN_MAX_CONCURRENT_RUNS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    for (const stream of [processHandle.stdout, processHandle.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-1500); });
    processHandle.on('exit', code => { if (code) console.error(`Isolated account transfer app failed (${code}): ${diagnostics}`); });
    const report = await runAccountTransferUiSmoke({ base, output });
    console.log(JSON.stringify({ result: report.result, checks: report.checks.length, screenshots: report.screenshots.length,
      report: path.join(output, 'report.json') }, null, 2));
  } finally {
    if (processHandle && processHandle.exitCode === null) {
      processHandle.kill('SIGTERM'); await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), delay(8000)]);
      if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
    }
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
