import { decodeScreen } from './screen.mjs';
import { statusConfig } from './effects.mjs';
import { safeSerialText, wifiScanResult } from './wifi.mjs';

export class SerialSession {
  constructor(port, { onStatus, onLog, onLost, onScan, onFrame, timeoutMs = 2500 }) {
    Object.assign(this, { port, onStatus, onLog, onLost, onScan, onFrame, timeoutMs });
    this.queue = Promise.resolve();
    this.closed = false;
    this.status = null;
  }
  async open() {
    await this.port.open({ baudRate: 115200 });
    this.opened = true;
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readTask = this.readLoop();
  }
  command(command) {
    const run = this.queue.then(() => this.transact(command));
    this.queue = run.catch(() => {});
    return run;
  }
  async transact(command) {
    if (this.closed || this.failed) throw new Error('串口已断开');
    const response = new Promise((resolve, reject) => {
      this.pending = { resolve, reject, expected: command === 'STATUS' ? 'STATUS' : command === 'PING' ? 'PONG' : command.startsWith('DESK ') ? 'OK DESK' : command.startsWith('WIFI SET ') ? 'OK WIFI SET' : `OK ${command}`, timer: setTimeout(() => this.fail(new Error('设备响应超时，请检查固件或重新连接')), this.timeoutMs) };
    });
    // Install the rejection handler before an asynchronous write can fail.
    const handled = response.then(value => ({ value }), error => ({ error }));
    // A blocked USB write must still be interruptible by the response timeout.
    // Keep the rejection handler attached even if the session closes first.
    try {
      this.writer.write(new TextEncoder().encode(command + '\n')).then(
        () => { if (!this.closed && !this.failed) this.onLog('tx', safeSerialText(command)); },
        error => this.fail(error),
      );
    } catch (error) { this.fail(error); }
    const result = await handled;
    if (result.error) throw result.error;
    return result.value;
  }
  rejectPending(error) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(error);
    this.pending = null;
  }
  fail(error) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.rejectPending(error);
    this.onLost(error);
  }
  receive(line) {
    if (this.closed || this.failed) return;
    if (line.startsWith('SCREEN ')) {
      try {
        const frame = JSON.parse(line.slice(7));
        if (!decodeScreen(frame)) throw new Error('Invalid screen frame');
        this.onFrame?.(frame);
      } catch (_) { this.onLog('err', '屏幕像素帧无效，请更新固件'); }
      return;
    }
    if (line.startsWith('WIFI_SCAN ')) {
      try {
        const result = wifiScanResult(JSON.parse(line.slice(10)));
        if (!result) throw new Error('Invalid scan result');
        this.onScan?.(result);
      } catch (_) { this.onLog('err', 'Wi-Fi 扫描结果无效，请重新扫描'); }
      return; // Background scans never acknowledge or reject an unrelated LED command.
    }
    if (line.startsWith('STATUS ')) {
      try {
        const status = JSON.parse(line.slice(7));
        if (!statusConfig(status)) throw new Error('不兼容的设备状态');
        this.status = status;
        this.onStatus(status);
      } catch (_) {
        this.onLog('err', '状态数据无效，请上传 v2 固件');
        return;
      }
    } else this.onLog(line.startsWith('ERR') ? 'err' : 'rx', safeSerialText(line));
    if (!this.pending) return;
    if (line.startsWith('ERR')) {
      const outdated = this.pending.expected === 'STATUS' && /^ERR unknown command:\s*STATUS$/i.test(line);
      this.rejectPending(new Error(outdated ? '板子仍是旧版固件，不支持状态同步；请运行 make upload 烧录 v2 固件后重新连接。' : safeSerialText(line)));
    }
    else if ((this.pending.expected === 'STATUS' && line.startsWith('STATUS ')) || line === this.pending.expected) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(line);
    }
  }
  async readLoop() {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.receive(line);
        }
        if (buffer.length > 8192) throw new Error('串口数据异常');
      }
      if (!this.closed) throw new Error('设备已断开');
    } catch (error) {
      this.fail(error);
    } finally { this.reader.releaseLock(); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('串口已断开'));
    try { await this.reader?.cancel(); } catch (_) {}
    await this.readTask;
    try { await this.queue; } catch (_) {}
    try { this.writer?.releaseLock(); } catch (_) {}
    if (this.opened) { try { await this.port.close(); } catch (_) {} }
  }
}
