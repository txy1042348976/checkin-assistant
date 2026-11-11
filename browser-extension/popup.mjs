import {BridgeError, hostPattern, oauthRoots, parseConnectionCode, requestedOrigins, safeMessage} from './helpers.mjs';

const $ = selector => document.querySelector(selector);
let connection = null;
let savedOrigin = null;
let busy = false;

function showError(message = '') {
  $('#status-message').hidden = !message;
  $('#status-message').textContent = message;
}

function screen(name) {
  for (const id of ['connect', 'import', 'done']) $(`#${id}-screen`).hidden = id !== name;
}

function setBusy(value, task = '') {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  $('#connect-button').innerHTML = value && task === 'connect' ? '正在连接…' : '连接签到助手 <span aria-hidden="true">↗</span>';
  $('#import-button').innerHTML = value && task === 'import' ? '正在核对并导入…' : '导入登录状态 <span aria-hidden="true">→</span>';
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new BridgeError(result?.error || '操作未完成，请重新打开扩展后重试。');
  return result;
}

function renderConnection(value) {
  connection = value;
  if (!value) return screen('connect');
  screen('import');
  $('#provider-name').textContent = value.provider.name;
  $('#assistant-address').textContent = value.origin;
  $('#account-name').textContent = value.name || '未填写';
  $('#include-oauth').checked = false;
  $('#oauth-option').hidden = !value.oauthAvailable;
  $('#oauth-name').textContent = value.method === 'github' ? 'GitHub' : 'LinuxDO';
  const minutes = Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 60000));
  $('#expiry-label').textContent = `连接码约 ${minutes} 分钟后失效`;
}

$('#connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  showError();
  try {
    const raw = $('#connection-code').value;
    const parsed = parseConnectionCode(raw);
    // Permission request begins directly in the user's click, before messaging.
    const permission = chrome.permissions.request({origins: [hostPattern(parsed.origin)]});
    setBusy(true, 'connect');
    if (!await permission) throw new BridgeError('未允许访问助手地址。连接码仍可重新使用。');
    const result = await send({action: 'connect', code: raw});
    $('#connection-code').value = '';
    renderConnection(result.connection);
  } catch (error) { showError(safeMessage(error)); }
  finally { setBusy(false); }
});

$('#import-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !connection) return;
  showError();
  try {
    const includeOAuth = $('#include-oauth').checked;
    if (includeOAuth && !oauthRoots(connection).length) throw new BridgeError('此站点无需额外导入上游登录状态。');
    const permission = chrome.permissions.request({origins: requestedOrigins(connection, includeOAuth)});
    setBusy(true, 'import');
    if (!await permission) throw new BridgeError('未允许本次站点访问，请保留原站登录后重新尝试。');
    const result = await send({action: 'import', id: connection.id, include_oauth: includeOAuth});
    savedOrigin = result.origin;
    connection = null;
    screen('done');
    $('#done-copy').textContent = `${result.providerName} 的账号已交给你自己的助手保存。回到控制台可查看余额、执行记录和自动运行设置。`;
  } catch (error) { showError(safeMessage(error)); }
  finally { setBusy(false); }
});

$('#open-site').addEventListener('click', async () => {
  if (!connection || busy) return;
  try { await chrome.tabs.create({url: connection.provider.domain + connection.provider.login_path}); }
  catch { showError('未能打开原站，请手动访问目标站点。'); }
});
$('#open-assistant').addEventListener('click', () => {
  if (savedOrigin) chrome.tabs.create({url: savedOrigin});
});
$('#new-connection').addEventListener('click', () => {
  showError();
  savedOrigin = null;
  renderConnection(null);
  $('#connection-code').focus();
});
$('#disconnect-button').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true);
  try { await send({action: 'disconnect'}); renderConnection(null); showError(); }
  catch (error) { showError(safeMessage(error)); }
  finally { setBusy(false); }
});

try {
  const result = await send({action: 'state'});
  renderConnection(result.connection);
} catch (error) { showError(safeMessage(error)); }
