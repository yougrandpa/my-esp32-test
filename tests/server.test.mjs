import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, readConfig } from '../server/server.mjs';
import { HttpSession } from '../web/http.mjs';
import { DeviceBridge } from '../server/device-bridge.mjs';

const status = { version: 2, mode: 'blink', brightness: 255, on_ms: 500, off_ms: 500, breathe_ms: 3000, sos_unit_ms: 150, elapsed_ms: 0, uptime_ms: 0, led_duty: 255, pin: 2 };
const token = 'test-password-for-gateway';
const authorization = `Basic ${Buffer.from(`esp32:${token}`).toString('base64')}`;
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, respond, options = {}) {
  const calls = [];
  const device = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers };
    calls.push(call);
    if (respond) return respond(call, res);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.method === 'POST' ? { ok: true, reply: 'OK DESK', status } : req.url === '/api/screen' ? { pixels: '00' } : status));
  });
  const deviceOrigin = await listen(device);
  const gateway = await createGateway({ deviceOrigin, ...options });
  const origin = await listen(gateway);
  t.after(async () => {
    for (const server of [gateway, device]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const command = (value, headers = {}) => fetch(`${origin}/api/command`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ command: value }),
  });
  return { origin, calls, command, gateway };
}

test('deployment configuration requires a fixed device and a password when exposed', () => {
  assert.throws(() => readConfig({}), /ESP32_URL/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://device/api' }), /根地址/);
  assert.throws(() => readConfig({ ESP32_URL: 'file:///etc/passwd' }), /根地址/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://user:secret@device' }), /根地址/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://device', HOST: '0.0.0.0' }), /ESP32_ACCESS_TOKEN/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://device', ESP32_ACCESS_TOKEN: 'short' }), /16/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://device', PORT: 'NaN' }), /PORT/);
  assert.throws(() => readConfig({ ESP32_URL: 'http://device', PUBLIC_ORIGIN: 'https://site/path' }), /PUBLIC_ORIGIN/);
  assert.equal(readConfig({ ESP32_URL: 'http://device' }).host, '127.0.0.1');
  assert.equal(readConfig({ ESP32_URL: 'http://device', HOST: '0.0.0.0', ESP32_ACCESS_TOKEN: token }).accessToken, token);
});

test('serves only the shared workbench assets, in server mode', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/esp32_led_control.html']) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /window.ESP32_SERVER = true/);
  }
  assert.match((await fetch(f.origin + '/web/app.mjs')).headers.get('content-type'), /javascript/);
  for (const path of ['/.env', '/server/server.mjs', '/README.md', '/platformio.ini', '/api/status?target=http://other']) {
    assert.ok((await fetch(f.origin + path)).status >= 400);
  }
  assert.equal(f.calls.length, 0);
});

test('password protects pages and APIs without exposing credentials to the device', async t => {
  const f = await fixture(t, null, { accessToken: token });
  for (const path of ['/', '/web/app.mjs', '/api/status', '/api/screen']) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic/);
  }
  assert.equal((await f.command('ON')).status, 401);
  assert.equal((await fetch(f.origin + '/healthz')).status, 200);
  assert.equal((await f.command('ON', { Authorization: authorization, Origin: f.origin })).status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls[0].headers.origin, undefined);
});

test('rejects cross-site commands, invalid forms, provisioning and multiple lines', async t => {
  const f = await fixture(t);
  assert.equal((await f.command('ON', { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.command('ON', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  for (const value of ['', 'ON\nOFF', 'ON\0', 'WIFI SET aa bb', 'x'.repeat(256)]) {
    assert.equal((await f.command(value)).status, 400);
  }
  const duplicate = await fetch(f.origin + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'command=ON&command=OFF' });
  assert.equal(duplicate.status, 400);
  assert.equal((await f.command('ON', { 'Content-Type': 'application/json' })).status, 415);
  assert.equal((await f.command('x'.repeat(3000))).status, 413);
  assert.equal(f.calls.length, 0);
});

test('HTTPS reverse proxy origin is configurable', async t => {
  const f = await fixture(t, null, { publicOrigin: 'https://esp32.example.com' });
  assert.equal((await f.command('DESK PAGE 3', { Origin: 'https://esp32.example.com' })).status, 200);
  assert.equal((await f.command('ON', { Origin: f.origin })).status, 403);
  assert.equal(f.calls[0].body, 'command=DESK+PAGE+3');
});

test('existing browser HTTP session controls the device through the gateway', async t => {
  let current = { ...status };
  const f = await fixture(t, (call, res) => {
    if (call.method === 'POST') current = { ...current, brightness: 80 };
    res.end(JSON.stringify(call.method === 'POST' ? { ok: true, reply: 'OK BRIGHT 80', status: current } : current));
  });
  const states = [], lost = [];
  const session = new HttpSession(f.origin, { onStatus: value => states.push(value), onLog() {}, onLost: error => lost.push(error), pollMs: 0 });
  await session.open();
  await session.command('BRIGHT 80');
  await session.command('STATUS');
  assert.equal(states.at(-1).brightness, 80);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/status', '/api/command', '/api/status']);
  assert.equal(lost.length, 0);
  await session.close();
});

test('device command rejection is preserved, and write requests are never retried', async t => {
  const f = await fixture(t, (_call, res) => {
    res.writeHead(400); res.end(JSON.stringify({ error: 'invalid control command' }));
  });
  const response = await f.command('DESK PAGE 9');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid control command');
  assert.equal(f.calls.length, 1);
});

test('timeouts and malformed responses become explicit gateway errors', async t => {
  const slow = await fixture(t, () => {}, { timeoutMs: 30 });
  const response = await slow.command('ON');
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /可能已生效/);
  assert.equal(slow.calls.length, 1);
  const invalid = await fixture(t, (_call, res) => res.end('<html>wrong device</html>'));
  assert.equal((await fetch(invalid.origin + '/api/status')).status, 502);
  const large = await fixture(t, (_call, res) => res.end('x'.repeat(20000)));
  assert.equal((await fetch(large.origin + '/api/status')).status, 413);
});

test('shares simultaneous reads, serializes multiple phones and reads after writes', async t => {
  let active = 0, maximum = 0, brightness = 255;
  const f = await fixture(t, async (call, res) => {
    active++; maximum = Math.max(maximum, active);
    const snapshot = { ...status, brightness };
    await new Promise(resolve => setTimeout(resolve, 25));
    if (call.method === 'POST') brightness = 80;
    res.end(JSON.stringify(call.method === 'POST' ? { ok: true, reply: 'OK BRIGHT 80', status: { ...status, brightness } } : snapshot));
    active--;
  });
  await Promise.all(Array.from({ length: 5 }, () => fetch(f.origin + '/api/status')));
  assert.equal(f.calls.length, 1);
  const read = fetch(f.origin + '/api/status');
  // Wait until this GET has reached the device, then enqueue the write.
  while (f.calls.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  const write = f.command('BRIGHT 80');
  // Wait until gateway queues the POST, before issuing the final GET.
  while (f.calls.length < 3) await new Promise(resolve => setTimeout(resolve, 1));
  const after = fetch(f.origin + '/api/status');
  await Promise.all([read, write]);
  assert.equal((await (await after).json()).brightness, 80);
  assert.equal(maximum, 1);
  assert.deepEqual(f.calls.slice(1).map(call => call.method), ['GET', 'POST', 'GET']);
});

test('cloud configuration requires a device secret, with no ESP32 LAN IP', () => {
  assert.throws(() => readConfig({ CONTROL_MODE: 'cloud' }), /ESP32_DEVICE_TOKEN/);
  const config = readConfig({ CONTROL_MODE: 'cloud', ESP32_DEVICE_TOKEN: token });
  assert.equal(config.mode, 'cloud'); assert.equal(config.deviceOrigin, '');
});

test('ESP32 initiates authenticated sync; browser commands wait for its acknowledgement', async t => {
  const gateway = await createGateway({ mode: 'cloud', deviceToken: token, accessToken: token });
  const origin = await listen(gateway);
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const sync = (value, auth = `Bearer ${token}`) => fetch(origin + '/api/device/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(value) });
  const payload = { boot_id: 123, status: { ...status, cloud: { supported: true, state: 'connected', url: origin, error: '' } }, frame: null, ack: null };
  assert.equal((await fetch(origin + '/api/status', { headers: { Authorization: authorization } })).status, 503);
  assert.equal((await sync(payload, authorization)).status, 401);
  assert.equal((await sync(payload, 'Bearer wrong')).status, 401);
  assert.equal((await sync(payload)).status, 200);
  const read = await fetch(origin + '/api/status', { headers: { Authorization: authorization } });
  assert.equal(read.status, 200); assert.ok((await read.json()).cloud.age_ms >= 0);
  let finished = false;
  const write = fetch(origin + '/api/command', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: authorization, Origin: origin }, body: 'command=BRIGHT+80' }).then(response => { finished = true; return response; });
  let command;
  for (let i = 0; i < 20 && !command; i++) { command = (await (await sync(payload)).json()).command; if (!command) await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(command.command, 'BRIGHT 80'); assert.equal(finished, false); assert.ok(command.ttl_ms > 0);
  const repeated = (await (await sync(payload)).json()).command;
  assert.equal(repeated.id, command.id);
  const confirmation = { ...payload, status: { ...payload.status, brightness: 80 }, ack: { id: command.id, ok: true, reply: 'OK BRIGHT 80' } };
  assert.equal((await sync(confirmation)).status, 200);
  const response = await write;
  assert.equal(response.status, 200); assert.equal((await response.json()).status.brightness, 80);
  assert.equal((await (await sync(confirmation)).json()).command, null);
});

test('cloud commands expire, cancel on reboot, and never reappear after reconnect', async () => {
  const bridge = new DeviceBridge({ commandMs: 30, offlineMs: 100 });
  const payload = { boot_id: 1, status, frame: null };
  bridge.sync(payload);
  const expired = bridge.command('ON');
  await assert.rejects(expired, /命令已取消/);
  assert.equal(bridge.sync(payload).command, null);
  const delivered = bridge.command('OFF');
  bridge.sync(payload);
  await assert.rejects(delivered, /可能已生效/);
  assert.equal(bridge.sync(payload).command, null);
  const pending = bridge.command('BRIGHT 80');
  bridge.sync({ ...payload, boot_id: 2 });
  await assert.rejects(pending, /重启/);
  assert.throws(() => bridge.sync(payload), /失效/);
  bridge.lastSeen -= 101;
  assert.throws(() => bridge.read('/api/status'), /掉线/);
  bridge.close();
});

test('cloud rejects stale, malformed and corrupt frame reports; aborted writes are cancelled', async () => {
  const bridge = new DeviceBridge();
  bridge.sync({ boot_id: 1, status: { ...status, uptime_ms: 100 } });
  assert.throws(() => bridge.sync({ boot_id: 1, status: { ...status, uptime_ms: 99 } }), /过期/);
  assert.throws(() => bridge.sync({ boot_id: 1, status, frame: { pixels: '00' } }), /像素帧/);
  assert.throws(() => bridge.sync({ boot_id: 1, status: { ...status, brightness: 256 } }), /格式/);
  const controller = new AbortController();
  const write = bridge.command('ON', controller.signal);
  controller.abort();
  await assert.rejects(write, /浏览器已断开/);
  assert.equal(bridge.sync({ boot_id: 1, status: { ...status, uptime_ms: 100 } }).command, null);
  bridge.close();
});
