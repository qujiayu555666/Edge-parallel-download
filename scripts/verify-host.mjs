// Verify the actual Windows launcher, including native-message framing and exit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [hostDirectory, expectedVersion] = process.argv.slice(2);
const executable = join(hostDirectory, 'EdgeParallelHost.exe');
function exchange(origin, expectReply) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let incoming = Buffer.alloc(0), replied = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native host timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      incoming = Buffer.concat([incoming, data]);
      if (incoming.length < 4 || incoming.length < incoming.readUInt32LE(0) + 4) return;
      try {
        assert.equal(expectReply, true);
        const reply = JSON.parse(incoming.subarray(4, incoming.readUInt32LE(0) + 4).toString('utf8'));
        assert.equal(reply.id, 'build-smoke');
        assert.equal(reply.ok, true);
        assert.equal(reply.ready, true);
        assert.equal(reply.version, expectedVersion);
        replied = true;
        child.stdin.end();
      } catch (error) { child.kill(); clearTimeout(timer); reject(error); }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      try { assert.equal(code, expectReply ? 0 : 2); assert.equal(replied, expectReply); resolve(); }
      catch (error) { reject(error); }
    });
    if (expectReply) {
      const body = Buffer.from(JSON.stringify({ id: 'build-smoke', action: 'ping' }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([prefix, body]));
    } else child.stdin.end();
  });
}
await exchange('chrome-extension://jcpnknmnbonffkcmnficeijhojknegbm/', true);
await exchange('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/', false);
console.log('Compiled native host: framed ping, version, clean shutdown and origin rejection passed.');
