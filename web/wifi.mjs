export const WIFI_STATES = { unconfigured: '尚未配网', connecting: '正在连接…', connected: '已连接 Wi-Fi', retry_wait: '连接失败 · 30 秒后自动重试', off: 'Wi-Fi 已关闭' };
export const WIFI_ERRORS = { connect_failed: '连接失败，请检查密码与路由器设置', ssid_unavailable: '找不到网络，请检查名称、距离和 2.4 GHz 频段', timeout: '连接超时，请检查网络和密码', connection_lost: '网络已断开，正在等待重连', storage_failed: '无法读取设备网络配置，请重新烧录或检查闪存' };

export function wifiConfigCommand(ssid, password) {
  const bytes = new TextEncoder().encode(ssid);
  if (bytes.length < 1 || bytes.length > 32 || ssid.includes('\0')) throw new Error('Wi-Fi 名称须为 1–32 字节（中文通常占 3 字节）');
  if (password && !(/^[\x20-\x7e]{8,63}$/.test(password) || /^[\da-f]{64}$/i.test(password))) throw new Error('密码须为 8–63 个英文字符，或 64 位十六进制密钥；开放网络可留空');
  const hex = value => [...new TextEncoder().encode(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `WIFI SET ${hex(ssid)} ${password ? hex(password) : '-'}`;
}

export function wifiStatus(value) {
  if (value && ['scanning', 'scan_supported'].some(key => key in value && typeof value[key] !== 'boolean')) return null;
  return value && Object.hasOwn(WIFI_STATES, value.state) && typeof value.ssid === 'string' && new TextEncoder().encode(value.ssid).length <= 32 && typeof value.ip === 'string' && (value.ip === '' || /^(\d{1,3}\.){3}\d{1,3}$/.test(value.ip) && value.ip.split('.').every(part => Number(part) <= 255)) && Number.isInteger(value.rssi) && value.rssi >= -127 && value.rssi <= 0 && typeof value.error === 'string' ? value : null;
}

export function safeSerialText(text) {
  return text.replace(/\bWIFI\s+SET\b[^\r\n]*/gi, 'WIFI SET [凭据已隐藏]');
}

export function wifiScanResult(value) {
  if (!value || !['', 'timeout', 'scan_failed'].includes(value.error) || typeof value.truncated !== 'boolean' || !Array.isArray(value.networks) || value.networks.length > 20) return null;
  const seen = new Set();
  const networks = [];
  for (const network of value.networks) {
    if (!network || typeof network.ssid !== 'string' || !network.ssid || network.ssid.includes('\0') || new TextEncoder().encode(network.ssid).length > 32 || !Number.isInteger(network.rssi) || network.rssi < -127 || network.rssi > 0 || typeof network.secure !== 'boolean') return null;
  }
  for (const network of [...value.networks].sort((a, b) => b.rssi - a.rssi)) {
    const key = JSON.stringify([network.ssid, network.secure]);
    if (!seen.has(key)) { seen.add(key); networks.push(network); }
  }
  return { error: value.error, truncated: value.truncated, networks };
}
