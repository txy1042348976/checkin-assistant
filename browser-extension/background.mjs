import {createBridge} from './bridge.mjs';
import {safeMessage} from './helpers.mjs';

chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
const handle = createBridge(chrome);

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
    reply({ok: false, error: '操作来源无效。'});
    return false;
  }
  handle(message).then(reply, error => reply({ok: false, error: safeMessage(error)}));
  return true;
});
