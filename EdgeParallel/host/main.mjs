import { createBridge } from './bridge.mjs';

const origin = process.argv[2]?.replace(/\/$/, '');
if (origin !== 'chrome-extension://jcpnknmnbonffkcmnficeijhojknegbm') process.exit(2);
const bridge = await createBridge();
let incoming = Buffer.alloc(0);
let pending = 0;
let closed = false;
function send(data) {
  if (closed) return;
  const body = Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}
async function shutdown() {
  if (closed) return;
  closed = true;
  await bridge.close();
  process.exit(0);
}
process.stdin.on('data', data => {
  incoming = Buffer.concat([incoming, data]);
  while (incoming.length >= 4) {
    const length = incoming.readUInt32LE(0);
    if (length < 2 || length > 64 * 1024) { void shutdown(); return; }
    if (incoming.length < length + 4) break;
    const body = incoming.subarray(4, length + 4);
    incoming = incoming.subarray(length + 4);
    let message;
    try { message = JSON.parse(body.toString('utf8')); } catch { void shutdown(); return; }
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') { void shutdown(); return; }
    if (pending >= 16) { send({ id: message.id, ok: false, error: '任务过多' }); continue; }
    pending++;
    bridge.handle(message).then(result => send({ id: message.id, ok: true, ...result }),
      error => send({ id: message.id, ok: false, error: error.message || '下载准备失败' })).finally(() => pending--);
  }
});
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
