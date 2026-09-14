// SPDX-License-Identifier: MIT
const enabled = document.querySelector('#enabled');
const connections = document.querySelector('#connections');
const minBytes = document.querySelector('#minBytes');
const result = document.querySelector('#result');
const test = document.querySelector('#test');
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展暂时无法响应，请重新打开此面板。');
  return response;
}
let polling = false;
let displayedError = '';
async function refresh(initial = false) {
 if (polling) return;
 polling = true;
 try {
  const status = await send({ op: 'status' });
  if (initial) {
  enabled.checked = status.settings.enabled;
  connections.value = String(status.settings.connections);
  minBytes.value = String(status.settings.minBytes);
  }
  document.querySelector('#active').textContent = status.active ? `正在加速 ${status.active} 个下载` : (status.settings.enabled ? '等待下载' : '自动加速已关闭');
  const decision = status.lastDecision;
  document.querySelector('#decision').textContent = decision ? `${decision.name}：${decision.reason}` : '';
  document.querySelector('#transfer').textContent = (status.transfer?.jobs || []).map(job =>
    `${job.activeConnections}/${job.connections} 个连接 · ${(job.bytesPerSecond/1048576).toFixed(1)} MiB/s`).join('；');
  if (status.lastError && status.lastError !== displayedError) result.textContent = status.lastError;
  displayedError = status.lastError || '';
 } catch (error) { if (error.message !== displayedError) result.textContent = error.message; displayedError = error.message; }
 finally { polling = false; }
}
await refresh(true);
const refreshTimer = setInterval(() => { void refresh(); }, 1000);
window.addEventListener('pagehide', () => clearInterval(refreshTimer), { once: true });
for (const field of [enabled, connections, minBytes]) field.addEventListener('change', async () => {
  try {
    await send({ op: 'settings', settings: { enabled: enabled.checked, connections: Number(connections.value), minBytes: Number(minBytes.value) } });
    result.textContent = '已保存，下次下载生效';
  } catch (error) { result.textContent = error.message; }
});
test.addEventListener('click', async () => {
  test.disabled = true;
  result.textContent = '正在连接…';
  try { const response = await send({ op: 'ping' }); result.textContent = `已连接${response.version ? ` · v${response.version}` : ''}`; }
  catch (error) { result.textContent = `未能连接。请先运行安装程序。${error.message}`; }
  finally { test.disabled = false; }
});
document.querySelector('#downloads').addEventListener('click', () => { chrome.tabs.create({ url: 'edge://downloads/' }); });
document.querySelector('#directForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.querySelector('#directDownload');
  button.disabled = true;
  result.textContent = '正在检查直链…';
  try {
    const started = await send({ op: 'direct', url: document.querySelector('#directUrl').value.trim() });
    result.textContent = `已开始：${started.filename}`;
    await refresh();
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
