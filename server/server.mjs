import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GatewayError } from './errors.mjs';
import { DeviceBridge } from './device-bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY = 2048;
const MAX_RESPONSE = 16384;

export function readConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
  const mode = env.CONTROL_MODE || 'proxy';
  if (!['cloud', 'proxy'].includes(mode)) throw new Error('CONTROL_MODE 必须为 cloud 或 proxy');
  const deviceToken = env.ESP32_DEVICE_TOKEN || '';
  let deviceOrigin = '';
  if (mode === 'cloud') {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceToken)) throw new Error('云端模式请设置 ESP32_DEVICE_TOKEN，使用 16–64 位英文、数字、下划线或短横线');
  } else {
    if (!env.ESP32_URL) throw new Error('请设置 ESP32_URL，例如 http://192.168.1.50');
    const device = new URL(env.ESP32_URL);
    if (!['http:', 'https:'].includes(device.protocol) || device.username || device.password ||
        device.pathname !== '/' || device.search || device.hash) throw new Error('ESP32_URL 必须为设备的 HTTP(S) 根地址');
    deviceOrigin = device.origin;
  }
  const accessToken = env.ESP32_ACCESS_TOKEN || '';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !accessToken) {
    throw new Error('向手机或外部网络开放时必须设置 ESP32_ACCESS_TOKEN');
  }
  if (accessToken && (accessToken.length < 16 || /[\r\n]/.test(accessToken))) throw new Error('访问密码至少 16 个字符，不能包含换行');
  let publicOrigin = '';
  if (env.PUBLIC_ORIGIN) {
    const url = new URL(env.PUBLIC_ORIGIN);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN 必须为网页的 HTTP(S) 根地址');
    publicOrigin = url.origin;
  }
  return { host, port, mode, deviceOrigin, deviceToken, accessToken, publicOrigin };
}

async function readLimited(stream, limit) {
  const chunks = [];
  let size = 0;
  const iterable = stream.iterator ? stream.iterator({ destroyOnReturn: false }) : stream;
  for await (const chunk of iterable) {
    size += chunk.length;
    if (size > limit) throw new GatewayError(413, '请求或设备回复过大');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// One fixed target, one device queue shared by all phones. Neither browser
// credentials nor its Origin header are forwarded to the board.
export async function createGateway({ deviceOrigin, mode = 'proxy', deviceToken = '', accessToken = '', publicOrigin = '', timeoutMs = 1800, bridgeOptions = {} }) {
  const bridge = mode === 'cloud' ? new DeviceBridge(bridgeOptions) : null;
  const assets = new Map();
  const page = (await readFile(resolve(root, 'esp32_led_control.html'), 'utf8'))
    .replace('<!-- ESP32_DEVICE_MODE -->', `<script>window.ESP32_DEVICE = true; window.ESP32_SERVER = true; window.ESP32_CLOUD = ${!!bridge};</script>`);
  for (const path of ['/', '/esp32_led_control.html']) assets.set(path, { type: 'text/html; charset=utf-8', body: page });
  for (const name of await readdir(resolve(root, 'web'))) {
    if (!/^[a-z_\-]+\.(mjs|css)$/.test(name)) continue;
    assets.set(`/web/${name}`, { type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', body: await readFile(resolve(root, 'web', name)) });
  }
  const expectedAuth = Buffer.from(`Basic ${Buffer.from(`esp32:${accessToken}`).toString('base64')}`);
  const expectedDeviceAuth = Buffer.from(`Bearer ${deviceToken}`);
  let queue = Promise.resolve(), pending = 0;
  const inFlightReads = new Map();

  function forward(path, body) {
    if (body === undefined && inFlightReads.has(path)) return inFlightReads.get(path);
    if (pending >= 4) return Promise.reject(new GatewayError(503, '设备繁忙，请稍后读取状态'));
    const deadline = Date.now() + timeoutMs;
    pending++;
    const result = queue.then(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayError(504, '等待设备超时，请重新读取状态');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const upstream = await fetch(new URL(path, deviceOrigin), {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
          headers: body === undefined ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        const bytes = await readLimited(upstream.body, MAX_RESPONSE);
        let value;
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch { throw new GatewayError(502, '设备返回了无效 JSON，请检查 ESP32_URL 和固件'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GatewayError(502, '设备回复格式无效');
        return { code: upstream.status, value };
      } catch (error) {
        if (error instanceof GatewayError) throw error;
        throw new GatewayError(controller.signal.aborted ? 504 : 502,
          controller.signal.aborted ? body === undefined ? '服务器访问 ESP32 局域网地址超时。此模式要求服务器能访问设备 IP；设备主动接入请使用 CONTROL_MODE=cloud' : 'ESP32 响应超时；写入结果可能已生效，请重新读取状态' : '服务器无法连接 ESP32，请检查设备地址、Wi-Fi 或 VPN');
      } finally { clearTimeout(timer); }
    }).finally(() => { pending--; });
    queue = result.catch(() => {});
    if (body === undefined) {
      inFlightReads.set(path, result);
      void result.finally(() => { if (inFlightReads.get(path) === result) inFlightReads.delete(path); }).catch(() => {});
    } else {
      // A read requested after a write must observe the write, never join an
      // earlier in-flight read. Previously queued reads keep their own result.
      inFlightReads.clear();
    }
    return result;
  }

  const server = http.createServer(async (req, res) => {
    const json = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, 'http://gateway.local');
      if (url.pathname === '/healthz' && req.method === 'GET') { json(200, { ok: true }); return; }
      if (url.pathname === '/api/device/sync' && req.method === 'POST' && bridge) {
        const auth = Buffer.from(req.headers.authorization || '');
        if (!deviceToken || auth.length !== expectedDeviceAuth.length || !timingSafeEqual(auth, expectedDeviceAuth)) throw new GatewayError(401, '设备密钥不匹配');
        if (url.search || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new GatewayError(400, '设备上报需要 JSON');
        let value;
        try { value = JSON.parse((await readLimited(req, MAX_RESPONSE)).toString('utf8')); }
        catch (error) { if (error instanceof GatewayError) throw error; throw new GatewayError(400, '设备 JSON 无效'); }
        json(200, bridge.sync(value)); return;
      }
      if (accessToken) {
        const auth = Buffer.from(req.headers.authorization || '');
        if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
          res.setHeader('WWW-Authenticate', 'Basic realm="ESP32 Controller", charset="UTF-8"');
          json(401, { error: '请输入用户名 esp32 和服务器访问密码' }); return;
        }
      }
      if (url.search) throw new GatewayError(400, '接口不接受查询参数');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.body); return;
      }
      if (['/api/status', '/api/screen'].includes(url.pathname) && req.method === 'GET') {
        const result = bridge ? bridge.read(url.pathname) : await forward(url.pathname); json(result.code, result.value); return;
      }
      if (url.pathname === '/api/command' && req.method === 'POST') {
        const origin = req.headers.origin;
        const expectedOrigin = publicOrigin || `http://${req.headers.host}`;
        if ((origin && origin !== expectedOrigin) || req.headers['sec-fetch-site'] === 'cross-site') {
          throw new GatewayError(403, '不接受来自其他网站的控制命令');
        }
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') {
          throw new GatewayError(415, '请使用 command 表单字段');
        }
        const fields = new URLSearchParams((await readLimited(req, MAX_BODY)).toString('utf8'));
        const command = fields.get('command');
        if ([...fields].length !== 1 || !command || Buffer.byteLength(command) >= 256 || /[\x00-\x1f\x7f]/.test(command)) {
          throw new GatewayError(400, '必须提交一条长度为 1–255 字节的 command');
        }
        if (/^\s*(WIFI|CLOUD)\b/i.test(command)) throw new GatewayError(400, '网络与服务器配网请通过 USB 串口操作');
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnected);
        let result;
        try { result = bridge ? await bridge.command(command, controller.signal) : await forward('/api/command', new URLSearchParams({ command }).toString()); }
        finally { res.removeListener('close', disconnected); }
        json(result.code, result.value); return;
      }
      throw new GatewayError(404, '未找到页面或接口');
    } catch (error) {
      req.resume();
      if (!res.destroyed) json(error instanceof GatewayError ? error.code : 500,
        { error: error instanceof GatewayError ? error.message : '服务器处理失败' });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.timeout = bridge ? 7000 : 5000;
  server.on('close', () => bridge?.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = readConfig();
    const server = await createGateway(config);
    server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(config.port, config.host, () => console.log(`ESP32 工作台：http://${config.host}:${config.port}（${config.accessToken ? '需登录，用户名 esp32' : '仅本机访问'}）`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
  } catch (error) { console.error(`启动失败：${error.message}`); process.exitCode = 1; }
}
