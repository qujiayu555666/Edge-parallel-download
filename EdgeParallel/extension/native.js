// SPDX-License-Identifier: MIT
export class NativeBridge {
  constructor(runtime, onDisconnect = () => {}) {
    this.runtime = runtime;
    this.onDisconnect = onDisconnect;
    this.port = null;
    this.pending = new Map();
  }
  connect() {
    if (this.port) return;
    const port = this.runtime.connectNative('com.edgeparallel.bridge');
    this.port = port;
    port.onMessage.addListener(message => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message);
      else request.reject(new Error(typeof message.error === 'string' ? message.error : message.error?.message || '本地下载助手无法处理此次下载。'));
    });
    port.onDisconnect.addListener(() => {
      const error = this.runtime.lastError?.message || '本地下载助手已断开。';
      if (this.port === port) this.port = null;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(error)); }
      this.pending.clear();
      this.onDisconnect(error);
    });
  }
  request(op, payload = {}, deadline = 5000) {
    return new Promise((resolve, reject) => {
      let id;
      try {
        this.connect();
        id = crypto.randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('本地下载助手响应超时，已保留原下载。'));
          // Abort this probe without disconnecting other active downloads.
          if (op === 'prepare') {
            try { this.port?.postMessage({ id: crypto.randomUUID(), action: 'release', requestId: id }); } catch { /* disconnected */ }
          }
        }, deadline);
        this.pending.set(id, { resolve, reject, timer });
        this.port.postMessage({ id, action: op === 'cancel' ? 'release' : op, ...payload });
      } catch (error) {
        if (id && this.pending.has(id)) clearTimeout(this.pending.get(id).timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}
