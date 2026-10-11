import { randomUUID } from 'node:crypto';
import { statusConfig } from '../web/effects.mjs';
import { decodeScreen, newerFrame } from '../web/screen.mjs';
import { GatewayError } from './errors.mjs';

// Every exchange is initiated by the device. A write is confirmed only by an
// explicit device ACK, and expires instead of waiting for a future reconnect.
export class DeviceBridge {
  constructor({ offlineMs = 6500, commandMs = 4500 } = {}) {
    Object.assign(this, { offlineMs, commandMs });
    this.boot = null; this.lastSeen = 0; this.status = null; this.frame = null;
    this.commands = []; this.retiredBoots = new Set();
  }
  requireOnline() {
    if (!this.status || Date.now() - this.lastSeen > this.offlineMs) {
      throw new GatewayError(503, 'ESP32 尚未接入服务器或已掉线。请通过 USB 配置服务器地址和设备密钥，并保持设备联网');
    }
  }
  read(path) {
    this.requireOnline();
    if (path === '/api/screen') {
      if (!this.frame) throw new GatewayError(503, 'ESP32 已接入，正在等待屏幕像素帧');
      return { code: 200, value: this.frame };
    }
    return { code: 200, value: { ...this.status, cloud: { ...this.status.cloud, age_ms: Date.now() - this.lastSeen } } };
  }
  command(command, signal) {
    this.requireOnline();
    if (this.commands.length >= 4) throw new GatewayError(503, '设备繁忙，请稍后操作');
    if (signal?.aborted) throw new GatewayError(499, '浏览器已断开');
    return new Promise((resolve, reject) => {
      const entry = { id: randomUUID(), command, boot: this.boot, expires: Date.now() + this.commandMs, resolve, reject };
      const cancel = () => this.finish(entry, new GatewayError(499, '浏览器已断开，命令结果需要重新读取状态'));
      entry.cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', cancel); };
      entry.timer = setTimeout(() => this.finish(entry, new GatewayError(504,
        entry.delivered ? '等待 ESP32 执行确认超时；操作可能已生效，请重新读取状态' : 'ESP32 未在有效期内领取命令，命令已取消')), this.commandMs);
      signal?.addEventListener('abort', cancel, { once: true });
      this.commands.push(entry);
    });
  }
  finish(entry, error, result) {
    const index = this.commands.indexOf(entry);
    if (index < 0) return;
    this.commands.splice(index, 1); entry.cleanup();
    if (error) entry.reject(error); else entry.resolve(result);
  }
  sync(value) {
    if (!value || !Number.isInteger(value.boot_id) || value.boot_id < 1 || value.boot_id > 0xffffffff || !statusConfig(value.status)) throw new GatewayError(400, '设备上报格式无效');
    const frame = value.frame == null ? null : decodeScreen(value.frame);
    if (value.frame != null && (!frame || frame.boot_id !== value.boot_id)) throw new GatewayError(400, '设备像素帧无效');
    const ack = value.ack;
    if (ack != null && (!ack || typeof ack.id !== 'string' || ack.id.length !== 36 || typeof ack.ok !== 'boolean' || typeof ack.reply !== 'string' || ack.reply.length > 128)) throw new GatewayError(400, '设备命令确认无效');
    if (this.retiredBoots.has(value.boot_id)) throw new GatewayError(409, '旧的开机会话已失效');
    if (this.boot !== value.boot_id) {
      if (this.boot !== null) {
        this.retiredBoots.add(this.boot);
        if (this.retiredBoots.size > 16) this.retiredBoots.delete(this.retiredBoots.values().next().value);
      }
      for (const command of [...this.commands]) this.finish(command, new GatewayError(503, 'ESP32 已重启，待确认命令已取消，请重新读取状态'));
      this.boot = value.boot_id; this.frame = null;
    } else if (((value.status.uptime_ms - this.status.uptime_ms) >>> 0) >= 0x80000000) throw new GatewayError(409, '设备状态已过期');
    this.status = value.status;
    if (frame && newerFrame(frame, this.frame)) { const { bytes, ...wireFrame } = frame; this.frame = wireFrame; }
    this.lastSeen = Date.now();
    if (ack) {
      const entry = this.commands.find(command => command.id === ack.id && command.boot === this.boot && command.delivered && command.expires > Date.now());
      if (entry) this.finish(entry, null, ack.ok
        ? { code: 200, value: { ok: true, reply: ack.reply, status: this.read('/api/status').value } }
        : { code: 400, value: { error: ack.reply || 'ESP32 拒绝了命令' } });
    }
    for (const command of [...this.commands]) if (command.expires <= Date.now()) this.finish(command, new GatewayError(504, '命令已过期，请重新读取状态'));
    const next = this.commands[0];
    if (next) next.delivered = true;
    return { ok: true, command: next ? { id: next.id, command: next.command, ttl_ms: Math.max(0, next.expires - Date.now()) } : null };
  }
  close() { for (const command of [...this.commands]) this.finish(command, new GatewayError(503, '服务器已停止，命令已取消')); }
}
