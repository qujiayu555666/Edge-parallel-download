// SPDX-License-Identifier: MIT
import { DownloadController, RequestMetadata, settingsFrom } from './core.js';
import { NativeBridge } from './native.js';

const metadata = new RequestMetadata();
let controller;
const native = new NativeBridge(chrome.runtime, () => { void controller?.disconnected(); });
controller = new DownloadController({
  downloads: chrome.downloads, storage: chrome.storage.session, native, metadata,
  onStatus: status => {
    void chrome.action.setBadgeText({ text: status.active ? String(status.active) : '' });
    void chrome.action.setBadgeBackgroundColor({ color: '#176b43' });
  }
});
const ready = (async () => {
  const data = await chrome.storage.local.get('settings');
  controller.settings = settingsFrom(data.settings);
  await controller.restore();
})();
const filter = { urls: ['http://*/*', 'https://*/*'] };
chrome.webRequest.onBeforeRequest.addListener(details => metadata.begin(details), filter);
chrome.webRequest.onBeforeSendHeaders.addListener(details => metadata.sent(details), filter, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(details => {
  metadata.received(details);
  void ready.then(() => controller.responseReady(details.url)).catch(() => {});
}, filter, ['responseHeaders', 'extraHeaders']);
chrome.downloads.onCreated.addListener(item => { void ready.then(() => controller.created(item)).catch(() => {}); });
chrome.downloads.onChanged.addListener(delta => { void ready.then(() => controller.changed(delta)).catch(() => {}); });
chrome.downloads.onErased.addListener(id => { void ready.then(() => controller.erased(id)).catch(() => {}); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) controller.settings = settingsFrom(changes.settings.newValue);
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!['status', 'ping', 'settings', 'direct'].includes(message?.op)) return false;
  void ready.then(async () => {
    if (message.op === 'settings') {
      controller.settings = settingsFrom(message.settings);
      await chrome.storage.local.set({ settings: controller.settings });
      reply({ ok: true, settings: controller.settings });
    } else if (message.op === 'ping') {
      const result = await native.request('ping');
      reply({ ok: true, version: result.version });
    } else if (message.op === 'direct') {
      reply({ ok: true, ...await controller.direct(message.url) });
    } else {
      let transfer = null;
      if (controller.status().active) {
        try { transfer = await native.request('status', {}, 3000); } catch { /* Show local decision if helper disconnects. */ }
      }
      reply({ ok: true, settings: controller.settings, ...controller.status(), transfer });
    }
  }).catch(error => reply({ ok: false, error: String(error.message || error) }));
  return true;
});
