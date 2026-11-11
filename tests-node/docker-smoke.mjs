import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {ApiClient, PASSWORD, ROOT, SECRETS, USERNAME, argumentsFor, freePort, ready, runUiSmoke, startFixture, until} from './ui-smoke.mjs';
import {runAccountTransferUiSmoke} from './account-transfer-ui-smoke.mjs';

async function docker(args, {timeout = 90000, allowFailure = false} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) reject(new Error(`docker ${args[0]} failed (${code}): ${stderr}`));
      else resolve({code, stdout: stdout.trim(), stderr});
    });
  });
}

async function containerNode(name, source, user = '1000:1000') {
  const result = await docker(['exec', '--user', user, name, 'node', '--input-type=module', '-e', source]);
  return JSON.parse(result.stdout);
}

async function localArtifacts() {
  const result = {};
  async function scan(directory) {
    for (const entry of await readdir(path.join(ROOT, directory), {withFileTypes: true})) {
      const filename = `${directory}/${entry.name}`;
      if (entry.name === '.DS_Store' || filename === 'browser-extension/tests' || ['web/remote.js', 'web/remote.css'].includes(filename)) continue;
      if (entry.isDirectory()) await scan(filename);
      else result[filename] = createHash('sha256').update(await readFile(path.join(ROOT, filename))).digest('hex');
    }
  }
  for (const directory of ['dist-server', 'web', 'browser-extension']) await scan(directory);
  for (const filename of ['package.json', 'package-lock.json', 'deploy/entrypoint.sh', 'deploy/healthcheck.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    result[filename] = createHash('sha256').update(await readFile(path.join(ROOT, filename))).digest('hex');
  }
  return result;
}

function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= Math.max(0, buffer.length - 65557) && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0 && buffer.readUInt32LE(end) === 0x06054b50, 'ZIP end record');
  assert.equal(buffer.readUInt16LE(end + 4), 0); assert.equal(buffer.readUInt16LE(end + 6), 0);
  const count = buffer.readUInt16LE(end + 10), entries = new Map();
  let offset = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, 'ZIP directory entry');
    const method = buffer.readUInt16LE(offset + 10), size = buffer.readUInt32LE(offset + 20);
    const length = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42), name = buffer.subarray(offset + 46, offset + 46 + length).toString('utf8');
    assert.equal(buffer.readUInt32LE(local), 0x04034b50, 'ZIP local entry');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    assert.ok(method === 0 || method === 8, 'ZIP compression');
    assert.ok(!entries.has(name) && !name.startsWith('/') && !name.split('/').includes('..'), 'ZIP safe unique filenames');
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    offset += 46 + length + extra + comment;
  }
  return entries;
}

const RUNTIME_INSPECTION = `
  import {accessSync, constants, readdirSync, readFileSync, statSync} from 'node:fs';
  import path from 'node:path';
  const commands=['python','python3','uv','Xvfb','x11vnc','vncserver','websockify','novnc_proxy'];
  const available=commands.filter(name=>(process.env.PATH||'').split(':').some(dir=>{
    try {accessSync(path.join(dir,name),constants.X_OK);return true;} catch{return false;}
  }));
  const pythonFiles=[];
  function scan(directory){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())scan(file);
      else if(/\\.py(?:c|o)?$/.test(entry.name))pythonFiles.push(file);
    }
  }
  scan('/app');
  const processes=[];
  for(const id of readdirSync('/proc').filter(value=>/^[0-9]+$/.test(value))){
    if(id===String(process.pid))continue;
    try{
      const status=readFileSync('/proc/'+id+'/status','utf8');
      const uid=Number(status.match(/^Uid:\\s+(\\d+)/m)[1]);
      const command=readFileSync('/proc/'+id+'/cmdline','utf8');
      const executable=path.basename(command.split('\\0')[0]||readFileSync('/proc/'+id+'/comm','utf8').trim());
      processes.push({executable,uid,application:command.includes('dist-server/main.js')});
    }catch{}
  }
  const listeners=[];
  for(const file of ['/proc/net/tcp','/proc/net/tcp6']){
    for(const line of readFileSync(file,'utf8').trim().split('\\n').slice(1)){
      const fields=line.trim().split(/\\s+/);
      if(fields[3]==='0A')listeners.push({address:fields[1].split(':')[0],port:parseInt(fields[1].split(':')[1],16)});
    }
  }
  const info=file=>{const stat=statSync(file);return {uid:stat.uid,gid:stat.gid,mode:(stat.mode&0o777).toString(8)};};
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
    available,pythonFiles,processes,listeners,retiredBrowserAssets:['/app/web/remote.js','/app/web/remote.css','/app/local-connector'].filter(file=>{
      try{statSync(file);return true;}catch{return false;}
    }),data:info('/data'),key:info('/data/secret.key'),database:info('/data/checkin-assistant.db')}));
`;

const EMPTY_SETUP_INSPECTION = `
  import {existsSync} from 'node:fs';
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync('/data/checkin-assistant.db',{readOnly:true});
  console.log(JSON.stringify({
    administrator_count:Number(db.prepare('SELECT COUNT(*) AS count FROM web_admin').get().count),
    session_count:Number(db.prepare('SELECT COUNT(*) AS count FROM web_sessions').get().count),
    account_count:Number(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count),
    setup_token_present:existsSync('/data/web-setup-token')
  }));
  db.close();
`;

const PERSISTENCE_INSPECTION = `
  import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
  import {createHash} from 'node:crypto';
  import {DatabaseSync} from 'node:sqlite';
  const db=new DatabaseSync('/data/checkin-assistant.db',{readOnly:true});
  const accounts=db.prepare('SELECT id,encrypted FROM accounts ORDER BY id').all();
  const admin=db.prepare('SELECT username,password_hash FROM web_admin WHERE id=1').get();
  const imports=db.prepare('SELECT status,encrypted_context FROM browser_imports').all();
  const secrets=${JSON.stringify(Object.values(SECRETS).concat(PASSWORD))};
  const plaintextFiles=readdirSync('/data').filter(name=>{
    const file='/data/'+name;
    return statSync(file).isFile()&&secrets.some(secret=>readFileSync(file).includes(Buffer.from(secret)));
  });
  console.log(JSON.stringify({key_sha256:createHash('sha256').update(readFileSync('/data/secret.key')).digest('hex'),
    administrator_count:Number(db.prepare('SELECT COUNT(*) AS count FROM web_admin').get().count),
    administrator_username:admin.username,
    administrator_password_hash_sha256:createHash('sha256').update(admin.password_hash).digest('hex'),
    account_ids:accounts.map(row=>row.id),credentials_encrypted:accounts.every(row=>row.encrypted.startsWith('gAAAA')),
    import_contexts_encrypted:imports.every(row=>row.encrypted_context.startsWith('gAAAA')),
    password_is_hash:typeof admin.password_hash==='string'&&admin.password_hash!==${JSON.stringify(PASSWORD)},
    plaintextFiles,setup_token_present:existsSync('/data/web-setup-token')}));
  db.close();
`;

async function main() {
  const args = argumentsFor(process.argv.slice(2));
  const image = args.image || 'checkin-assistant:node-test';
  const output = path.resolve(args.output || path.join(ROOT, 'build/test-node-docker'));
  await mkdir(output, {recursive: true});
  const report = {result: 'running', started_at: new Date().toISOString(), checks: [], image, cleanup_errors: []};
  const mark = name => { report.checks.push(name); console.log(`${name}: passed`); };
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'checkin-node-docker-'));
  const suffix = randomUUID().slice(0, 12), name = `checkin-node-fixture-${suffix}`;
  const productionName = `checkin-node-production-${suffix}`;
  const ownContainers = new Set();
  let fixture;
  try {
    const inspected = JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
    report.image_id = inspected.Id; report.image_architecture = inspected.Architecture; report.image_os = inspected.Os;
    assert.equal(inspected.Os, 'linux');
    fixture = await startFixture({host: '0.0.0.0', advertisedHost: 'host.docker.internal'});
    const data = path.join(temporary, 'data'), providers = path.join(temporary, 'providers.json');
    await mkdir(data, {mode: 0o700}); await writeFile(providers, JSON.stringify(fixture.providers), {mode: 0o644});
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    ownContainers.add(name);
    await docker(['run', '-d', '--name', name, '--shm-size=512m', '--memory=2g', '--security-opt=no-new-privileges:true',
      '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${port}:8765`,
      '--mount', `type=bind,source=${data},target=/data`, '--mount', `type=bind,source=${providers},target=/test/providers.json,readonly`,
      '-e', 'NODE_ENV=test', '-e', 'CHECKIN_TEST_PROVIDERS_FILE=/test/providers.json',
      '-e', `CHECKIN_PUBLIC_URL=${base}`, '-e', 'CHECKIN_ADMIN_USER=', '-e', 'CHECKIN_ADMIN_PASSWORD=',
      image]);
    const health = await ready(base, 60000); assert.equal(health.runtime, 'node'); assert.match(health.node, /^v24\./);
    await until(async () => (await docker(['inspect', '--format', '{{.State.Health.Status}}', name])).stdout === 'healthy', 'Docker Node healthcheck', 70000);
    report.health = health;
    mark('built Linux image starts with Node.js 24 and passes its Node healthcheck');

    const initialAuth = await new ApiClient(base).json('/api/auth/status');
    assert.deepEqual(initialAuth, {web_mode: true, configured: false, authenticated: false, username: null, setup_required: true});
    const emptySetup = await containerNode(name, EMPTY_SETUP_INSPECTION);
    assert.deepEqual(emptySetup, {administrator_count: 0, session_count: 0, account_count: 0, setup_token_present: false});
    report.first_run = {status: initialAuth, private_storage: emptySetup};
    mark('empty data volume has no administrator, sessions, accounts or initialization token and offers web setup');

    report.ui = await runUiSmoke({base, fixtureOrigin: fixture.origin, fixtureControl: fixture.control,
      username: USERNAME, password: PASSWORD, output: path.join(output, 'ui')});
    assert.equal(report.ui.result, 'passed');
    mark('actual container UI/API passes manual credential entry, Agent password entry and local check-in flows');

    report.chromium = await containerNode(name, `
      import assert from 'node:assert/strict';
      import {chromium} from 'playwright-core';
      const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
      try{
        const page=await browser.newPage();await page.goto(${JSON.stringify(fixture.origin + '/any/login')});
        assert.equal(await page.locator('h1').innerText(),'用户浏览器 · 本地原站');
        console.log(JSON.stringify({uid:process.getuid(),version:browser.version(),headless:true,fixture_reachable:true}));
      }finally{await browser.close();}
    `);
    assert.equal(report.chromium.uid, 1000);
    mark('bundled system Chromium runs headless as uid 1000 and reaches the local fixture');

    report.runtime = await containerNode(name, RUNTIME_INSPECTION, '0:0');
    // Docker Desktop's bind mount UID view can differ by caller. Validate private
    // files from the same uid that reads and writes them in the application.
    Object.assign(report.runtime, await containerNode(name, `
      import {statSync} from 'node:fs';
      const info=file=>{const stat=statSync(file);return {uid:stat.uid,gid:stat.gid,mode:(stat.mode&0o777).toString(8)};};
      console.log(JSON.stringify({data:info('/data'),key:info('/data/secret.key'),database:info('/data/checkin-assistant.db')}));
    `));
    assert.match(report.runtime.node, /^v24\./); assert.deepEqual(report.runtime.available, []); assert.deepEqual(report.runtime.pythonFiles, []);
    assert.deepEqual(report.runtime.retiredBrowserAssets, []);
    const appProcesses = report.runtime.processes.filter(process => process.application && process.executable === 'node');
    assert.equal(appProcesses.length, 1); assert.equal(appProcesses[0].uid, 1000);
    assert.ok(!report.runtime.processes.some(process => /python|^uv$|xvfb|vnc|websockify/i.test(process.executable)));
    assert.ok(report.runtime.listeners.some(listener => listener.port === 8765));
    assert.ok(!report.runtime.listeners.some(listener => [5900, 5901, 6080, 9222].includes(listener.port)));
    assert.deepEqual(report.runtime.data, {uid: 1000, gid: 1000, mode: '700'});
    assert.deepEqual(report.runtime.key, {uid: 1000, gid: 1000, mode: '600'});
    assert.deepEqual(report.runtime.database, {uid: 1000, gid: 1000, mode: '600'});
    mark('runtime has no Python/uv/.py files or remote-browser services and keeps private data permissions');

    const packaged = await containerNode(name, `
      import {readdirSync,readFileSync} from 'node:fs';
      import {createHash} from 'node:crypto';
      const result={};
      function scan(directory){for(const entry of readdirSync('/app/'+directory,{withFileTypes:true})){
        const file=directory+'/'+entry.name;
        if(entry.isDirectory())scan(file);else result[file]=createHash('sha256').update(readFileSync('/app/'+file)).digest('hex');
      }}
      for(const directory of ['dist-server','web','browser-extension'])scan(directory);
      for(const file of ['package.json','package-lock.json','deploy/entrypoint.sh','deploy/healthcheck.mjs','LICENSE','THIRD_PARTY_NOTICES.md'])result[file]=createHash('sha256').update(readFileSync('/app/'+file)).digest('hex');
      console.log(JSON.stringify(result));
    `);
    assert.deepEqual(packaged, await localArtifacts());
    report.artifacts = {files: Object.keys(packaged).length,sha256_matches_local_build: true};
    mark('packaged server, modern UI, optional extension and deployment scripts match the local build bytes');

    const api = new ApiClient(base);
    await api.json('/api/auth/login', {method: 'POST', csrf: false, body: {username: USERNAME, password: PASSWORD}});
    assert.equal((await api.json('/api/auth/status')).username, USERNAME);
    const bootstrap = await api.json('/api/bootstrap');
    assert.equal(bootstrap.web.authorization_mode, 'manual');
    assert.equal(bootstrap.web.connector_url, undefined); assert.equal(bootstrap.web.connector_version, undefined);
    assert.deepEqual(bootstrap.engine.login_methods, ['password', 'session']);
    const archiveResponse = await fetch(base + '/downloads/checkin-assistant-browser-extension.zip', {
      headers: {Cookie: api.cookie}, signal: AbortSignal.timeout(10000)});
    assert.equal(archiveResponse.status, 200);
    const archive = Buffer.from(await archiveResponse.arrayBuffer()), files = unzip(archive);
    const whitelist = ['manifest.json', 'background.mjs', 'bridge.mjs', 'helpers.mjs', 'popup.html', 'popup.css', 'popup.mjs',
      'shield.svg', 'README.md', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'];
    assert.deepEqual([...files.keys()].sort(), whitelist.sort());
    const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
    assert.equal(manifest.manifest_version, 3); assert.ok(manifest.name.startsWith('签到助手'));
    assert.deepEqual(manifest.host_permissions || [], []); assert.equal(manifest.incognito, 'not_allowed');
    for (const filename of ['16', '32', '48', '128'].map(size => `icons/${size}.png`)) assert.equal(files.get(filename).readUInt32BE(0), 0x89504e47);
    report.extension_files = [...files.keys()];
    mark('downloadable extension ZIP contains only complete distributable files with optional site permissions');

    const manualBody = {provider: 'anyrouter', name: 'Docker 持久化账号', interval_hours: 12, proxy: {mode: 'direct'},
      session: SECRETS.any, api_user: '7', request_id: randomUUID().replaceAll('-', '')};
    const saved = await api.json('/api/accounts/import', {method: 'POST', body: manualBody});
    assert.equal(saved.status, 'success');
    const pending = await api.json('/api/login/start', {method: 'POST', body: {provider: 'fixture-sub2api', method: 'manual',
      name: 'Docker 重启后导入', interval_hours: 12, proxy: {mode: 'direct'}}});
    const connection = pending.connection;
    const connectorRoute = '/downloads/checkin-assistant-local-connector.zip';
    assert.equal((await api.request(connectorRoute, {auth: false})).status, 404);
    assert.equal((await api.request(connectorRoute, {auth: false,
      headers: {Authorization: `Bearer ${connection.ticket}`}})).status, 404);
    assert.equal((await api.request(connectorRoute)).status, 404);
    report.manual_entry = {authorization_mode: bootstrap.web.authorization_mode, connector_download_removed: true,
      connector_runtime_removed: true, saved_without_checkin: saved.status === 'success'};
    mark('manual entry is the default and retired connector downloads and runtime resources are absent');
    const descriptor = await api.request(`/api/browser-import/${connection.id}`, {auth: false,
      headers: {Authorization: `Bearer ${connection.ticket}`}});
    assert.equal(descriptor.status, 200); assert.ok(!descriptor.text.includes(connection.ticket));
    const before = await api.json('/api/bootstrap'), cookie = api.cookie, staleCsrf = api.csrf;
    const storedBefore = await containerNode(name, PERSISTENCE_INSPECTION);
    assert.equal(storedBefore.credentials_encrypted, true); assert.equal(storedBefore.import_contexts_encrypted, true);
    assert.equal(storedBefore.password_is_hash, true); assert.deepEqual(storedBefore.plaintextFiles, []);
    assert.equal(storedBefore.setup_token_present, false);
    assert.equal(storedBefore.administrator_count, 1); assert.equal(storedBefore.administrator_username, USERNAME);
    await docker(['restart', '--time', '30', name]); await ready(base, 60000);
    assert.equal((await api.request('/api/settings', {method: 'PATCH', body: {scheduler_enabled: false, interval_hours: 12},
      headers: {'X-CSRF-Token': staleCsrf}})).status, 403);
    const after = await api.json('/api/bootstrap'); assert.equal(api.cookie, cookie);
    assert.deepEqual(after.accounts, before.accounts); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.settings, before.settings);
    assert.equal(after.authorization.connection.id, connection.id); assert.equal(after.authorization.connection.ticket, connection.ticket);
    const storedAfter = await containerNode(name, PERSISTENCE_INSPECTION);
    assert.equal(storedAfter.key_sha256, storedBefore.key_sha256); assert.deepEqual(storedAfter.account_ids, storedBefore.account_ids);
    assert.deepEqual(storedAfter.plaintextFiles, []);
    assert.equal(storedAfter.administrator_count, 1); assert.equal(storedAfter.administrator_username, USERNAME);
    assert.equal(storedAfter.administrator_password_hash_sha256, storedBefore.administrator_password_hash_sha256);
    assert.equal(storedAfter.setup_token_present, false);

    const setupReplay = new ApiClient(base);
    const rejectedSetup = await setupReplay.request('/api/auth/setup', {method: 'POST', csrf: false,
      body: {username: 'replacement-owner', password: 'Replacement-Owner-Fixture-2026!'}});
    assert.equal(rejectedSetup.status, 409); assert.equal(rejectedSetup.data.detail, '管理员账号已经配置。');
    assert.equal(setupReplay.cookie, ''); assert.deepEqual(rejectedSetup.headers.getSetCookie(), []);
    assert.deepEqual(await setupReplay.json('/api/auth/status'),
      {web_mode: true, configured: true, authenticated: false, username: null, setup_required: false});
    const afterRejectedSetup = await containerNode(name, PERSISTENCE_INSPECTION);
    assert.equal(afterRejectedSetup.administrator_count, 1); assert.equal(afterRejectedSetup.administrator_username, USERNAME);
    assert.equal(afterRejectedSetup.administrator_password_hash_sha256, storedBefore.administrator_password_hash_sha256);
    assert.equal(afterRejectedSetup.setup_token_present, false); assert.deepEqual(afterRejectedSetup.plaintextFiles, []);
    const persistentAuth = await api.json('/api/auth/status');
    assert.equal(persistentAuth.authenticated, true); assert.equal(persistentAuth.username, USERNAME); assert.equal(api.cookie, cookie);
    const freshLogin = new ApiClient(base);
    const loginAfterRestart = await freshLogin.json('/api/auth/login', {method: 'POST', csrf: false,
      body: {username: USERNAME, password: PASSWORD}});
    assert.equal(loginAfterRestart.authenticated, true); assert.equal(loginAfterRestart.username, USERNAME);
    Object.assign(report.first_run, {administrator_username: USERNAME, repeated_setup_status: rejectedSetup.status,
      repeated_setup_issued_session: false, administrator_password_unchanged: true, original_login_after_restart: true});
    mark('restart preserves the chosen administrator and password and rejects setup without replacing credentials or issuing a session');

    const replayed = await api.json('/api/accounts/import', {method: 'POST', body: manualBody});
    assert.equal(replayed.account_id, saved.account_id);
    assert.equal((await api.json('/api/bootstrap')).accounts.length, after.accounts.length);
    const restoredDescriptor = await api.request(`/api/browser-import/${connection.id}`, {auth: false,
      headers: {Authorization: `Bearer ${connection.ticket}`}});
    assert.equal(restoredDescriptor.status, 200);
    const restoredImport = await api.json(`/api/browser-import/${connection.id}`, {method: 'POST', auth: false, csrf: false,
      headers: {Authorization: `Bearer ${connection.ticket}`}, body: {session: SECRETS.sub, api_user: '11', refresh_token: SECRETS.refresh}});
    assert.equal(restoredImport.status, 'success');
    assert.equal((await api.request(`/api/browser-import/${connection.id}`, {auth: false,
      headers: {Authorization: `Bearer ${connection.ticket}`}})).status, 410);
    await api.json(`/api/accounts/${saved.account_id}/run`, {method: 'POST', body: {}});
    const restoredRun = await until(async () => {
      const bootstrap = await api.json('/api/bootstrap');
      return bootstrap.runs.find(run => run.account_id === saved.account_id && !['queued', 'running'].includes(run.status));
    }, 'decrypted account executes after container restart', 65000);
    assert.equal(restoredRun.status, 'already_checked'); assert.equal(restoredRun.reward, 0);
    report.persistence = {key_unchanged: true,administrator_cookie_survived: true,administrator_username: USERNAME,
      administrator_password_unchanged: true,repeated_setup_rejected: true,account_snapshot_survived: true,
      logs_survived: true,pending_bearer_survived: true,manual_nonce_survived: true,import_after_restart: true,decrypted_run_status: restoredRun.status,
      private_storage: await containerNode(name, PERSISTENCE_INSPECTION)};
    assert.deepEqual(report.persistence.private_storage.plaintextFiles, []);
    mark('container restart retains the key, encrypted accounts, administrator session, logs and pending scoped import');

    const productionData = path.join(temporary, 'production-data'); await mkdir(productionData, {mode: 0o700});
    const productionPort = await freePort(), productionBase = `http://127.0.0.1:${productionPort}`;
    ownContainers.add(productionName);
    await docker(['run', '-d', '--name', productionName, '--memory=2g', '--security-opt=no-new-privileges:true',
      '--add-host', 'host.docker.internal:host-gateway', '-p', `127.0.0.1:${productionPort}:8765`,
      '--mount', `type=bind,source=${productionData},target=/data`, '-e', 'NODE_ENV=production',
      '-e', 'CHECKIN_TEST_PROVIDERS_FILE=/intentionally-missing-test-file.json', '-e', `CHECKIN_PUBLIC_URL=${productionBase}`,
      '-e', `CHECKIN_ADMIN_PASSWORD=${PASSWORD}`, image]);
    await ready(productionBase, 60000);
    const productionApi = new ApiClient(productionBase);
    await productionApi.json('/api/auth/login', {method: 'POST', csrf: false, body: {username: 'admin', password: PASSWORD}});
    const productionBootstrap = await productionApi.json('/api/bootstrap');
    assert.equal(productionBootstrap.providers.find(provider => provider.id === 'anyrouter').domain, 'https://anyrouter.top');
    assert.equal(productionBootstrap.providers.find(provider => provider.id === 'agentrouter').domain, 'https://agentrouter.org');
    assert.equal(productionBootstrap.providers.length, 2); assert.equal(productionBootstrap.accounts.length, 0);
    assert.equal(productionBootstrap.web.authorization_mode, 'manual'); assert.equal(productionBootstrap.web.remote_browser, false);
    assert.equal(productionBootstrap.web.connector_url, undefined); assert.equal(productionBootstrap.web.connector_version, undefined);
    mark('production image ignores the test provider override and defaults to manual credential entry');

    report.account_transfer_ui = await runAccountTransferUiSmoke({base: productionBase, password: PASSWORD,
      output: path.join(output, 'account-transfer-ui')});
    assert.equal(report.account_transfer_ui.result, 'passed');
    assert.deepEqual(report.account_transfer_ui.outbound_business_requests, []);
    assert.equal((await productionApi.json('/api/bootstrap')).accounts.length, 0);
    mark('production image passes account file export, encrypted preview and duplicate-safe paused import in isolated UI');

    report.fixture = fixture.state;
    assert.deepEqual(report.fixture.login_posts, {any: 2, agent: 1, sub: 1});
    assert.deepEqual(report.fixture.checkin_posts, {any: 2, agent: 0, sub: 1});
    assert.deepEqual(report.fixture.forbidden, []);
    report.result = 'passed';
    console.log(JSON.stringify({result: report.result, checks: report.checks.length, ui_checks: report.ui.checks.length,
      screenshots: report.ui.screenshots.length, account_transfer_checks: report.account_transfer_ui.checks.length,
      account_transfer_screenshots: report.account_transfer_ui.screenshots.length,
      node: report.health.node, chromium: report.chromium.version,
      image_id: report.image_id, architecture: report.image_architecture, report: path.join(output, 'report.json')}, null, 2));
  } catch (error) {
    report.result = 'failed';
    report.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    for (const container of ownContainers) {
      const cleanup = `import {chownSync,chmodSync,readdirSync} from 'node:fs';function own(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const file=directory+'/'+entry.name;if(entry.isDirectory())own(file);else chownSync(file,${process.getuid?.() || 0},${process.getgid?.() || 0});}chownSync(directory,${process.getuid?.() || 0},${process.getgid?.() || 0});chmodSync(directory,0o700);}own('/data');`;
      const permissions = await docker(['exec', '--user', '0:0', container, 'node', '--input-type=module', '-e', cleanup], {allowFailure: true}).catch(() => null);
      if (permissions?.code && permissions.code !== 0) report.cleanup_errors.push('Could not restore temporary bind directory ownership');
      await docker(['rm', '-f', container], {allowFailure: true}).catch(() => { report.cleanup_errors.push('Could not remove own fixture container'); });
    }
    if (fixture) await fixture.close();
    await rm(temporary, {recursive: true, force: true}).catch(() => { report.cleanup_errors.push('Could not remove own temporary directory'); });
    report.finished_at = new Date().toISOString();
    await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
