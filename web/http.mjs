import { decodeScreen } from './screen.mjs';
import { statusConfig } from './effects.mjs';

class CommandError extends Error {}

// Keep status polling and commands in one queue so an older GET cannot overwrite
// the state returned by a newer command. Mutations are never retried automatically.
export class HttpSession {
  constructor(origin, { onStatus, onFrame, onLog, onLost, timeoutMs = 2500, pollMs = 500, fetchImpl = globalThis.fetch?.bind(globalThis) }) {
    Object.assign(this, { origin, onStatus, onFrame, onLog, onLost, timeoutMs, pollMs, fetchImpl });
    this.queue = Promise.resolve();
    this.closed = false;
    this.status = null;
  }
  async open() {
    await this.command('STATUS');
    this.opened = true;
    if (this.pollMs > 0 && !this.closed && !this.failed) this.timer = setInterval(() => {
      if (this.polling || this.closed || this.failed) return;
      this.polling = true;
      this.enqueue('STATUS', false).catch(error => this.fail(error)).finally(() => { this.polling = false; });
    }, this.pollMs);
  }
  command(command) { return this.enqueue(command, true); }
  enqueue(command, log) {
    const run = this.queue.then(() => this.transact(command, log));
    this.queue = run.catch(() => {});
    return run;
  }
  fail(error) {
    if (this.closed || this.failed) return;
    this.failed = true;
    clearInterval(this.timer);
    this.onLost(error);
  }
  async request(path, options = {}) {
    // A transient hotspot delay may interrupt a read. Retry reads once in the
    // same queue; never repeat a mutation whose outcome may already be committed.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await this.requestOnce(path, options); }
      catch (error) {
        if (error instanceof CommandError) throw error;
        if (attempt === 0 && !options.method && !this.closed && !this.failed) continue;
        this.fail(error); throw error;
      }
    }
  }
  async requestOnce(path, options = {}) {
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.origin).href, { ...options, cache: 'no-store', signal: controller.signal });
      const value = await response.json();
      if (!response.ok) {
        const message = typeof value?.error === 'string' ? value.error : `HTTP ${response.status}`;
        if (response.status < 500) throw new CommandError(message);
        throw new Error(message);
      }
      if (this.closed) throw new Error('Wi-Fi 会话已断开');
      return value;
    } catch (error) {
      if (error instanceof CommandError) throw error;
      const failure = new Error(this.closed ? 'Wi-Fi 会话已断开' : timedOut ? 'Wi-Fi 设备响应超时，请检查网络或重新连接' : `Wi-Fi 请求失败：${error.message}`);
      throw failure;
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = null;
    }
  }
  acceptStatus(value) {
    if (!statusConfig(value)) throw new Error('不兼容的设备状态，请更新固件');
    this.status = value;
    this.onStatus(value);
  }
  async transact(command, log) {
    if (this.closed || this.failed) throw new Error('Wi-Fi 会话已断开');
    if (/^\s*WIFI\b/i.test(command)) throw new CommandError('网络配置请通过 USB 串口操作');
    if (log) this.onLog('tx', command);
    try {
      if (command === 'STATUS') {
        const status = await this.request('/api/status');
        this.acceptStatus(status);
        if (status.display && this.onFrame) {
          const frame = await this.request('/api/screen');
          if (!decodeScreen(frame)) throw new Error('设备像素帧无效，请升级固件');
          this.onFrame(frame);
        }
        return 'STATUS';
      }
      const result = await this.request('/api/command', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ command }).toString(),
      });
      if (result?.ok !== true || typeof result.reply !== 'string') throw new Error('无效的命令确认');
      this.acceptStatus(result.status);
      if (log) this.onLog('rx', result.reply);
      return result.reply;
    } catch (error) {
      if (!(error instanceof CommandError)) this.fail(error);
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.queue;
  }
}
