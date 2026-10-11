import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, dutyAt, statusConfig, validConfig, modeCommand } from '../web/effects.mjs';
import { FAVORITES_KEY, readFavorites, writeFavorites, favoriteId } from '../web/favorites.mjs';
import { SerialSession } from '../web/serial.mjs';
import { HttpSession } from '../web/http.mjs';
import { wifiConfigCommand, wifiStatus, wifiScanResult } from '../web/wifi.mjs';
import { cloudConfigCommand } from '../web/cloud.mjs';

const status = { version: 2, mode: 'blink', brightness: 255, on_ms: 500, off_ms: 500, breathe_ms: 3000, sos_unit_ms: 150, elapsed_ms: 0, uptime_ms: 0, led_duty: 255, pin: 2 };

test('cloud pairing rejects board-local addresses and hides device secrets in serial logs', async () => {
  const token = 'private-device-token-test';
  const command = cloudConfigCommand('http://172.20.10.2:8000/', token);
  assert.equal(command, `CLOUD SET http://172.20.10.2:8000 ${token}`);
  for (const url of ['http://localhost:8000', 'http://127.0.0.1', 'http://device/api', 'http://user:pass@device', 'http://device:99999', 'ftp://device']) assert.throws(() => cloudConfigCommand(url, token));
  assert.throws(() => cloudConfigCommand('https://controller.example.com', 'short'));
  const mock = mockSession((command, emit) => emit(command === 'STATUS' ? `STATUS ${JSON.stringify(status)}\n` : 'OK CLOUD SET\n'));
  await mock.session.open();
  await mock.session.command(command);
  assert.ok(!JSON.stringify(mock.logs).includes(token));
  assert.ok(JSON.stringify(mock.logs).includes('凭据已隐藏'));
  await mock.session.close();
});

test('preview follows breathing envelope, zero peak and independent Morse sequence', () => {
  const breathe = { ...DEFAULTS, mode: 'breathe' };
  const samples = [0, 750, 1500, 2250, 3000].map(ms => dutyAt(breathe, ms));
  [0, 128, 255, 128, 0].forEach((expected, index) => assert.ok(Math.abs(samples[index] - expected) <= 1));
  for (let ms = 0; ms <= 3000; ms++) assert.equal(dutyAt({ ...breathe, brightness: 0 }, ms), 0);
  const expected = [];
  for (const [letter, marks] of ['...', '---', '...'].entries()) {
    for (const [i, mark] of [...marks].entries()) {
      expected.push(...Array(mark === '-' ? 3 : 1).fill(255));
      expected.push(...Array(i < 2 ? 1 : letter < 2 ? 3 : 7).fill(0));
    }
  }
  const sos = { ...DEFAULTS, mode: 'sos' };
  for (const [i, value] of expected.entries()) {
    assert.equal(dutyAt(sos, i * 150), value);
    assert.equal(dutyAt(sos, (i + 1) * 150 - 1), value);
    assert.equal(dutyAt(sos, (i + 34) * 150), value);
  }
  assert.equal(dutyAt({ ...DEFAULTS, mode: 'off' }, 100), 0);
  assert.equal(dutyAt(DEFAULTS, 500), 0);
  assert.equal(modeCommand(breathe), 'BREATHE 3000');
  assert.equal(modeCommand(sos), 'SOS 150');
});

test('invalid device states cannot masquerade as confirmed configuration', () => {
  assert.deepEqual(statusConfig(status), DEFAULTS);
  for (const invalid of [{ version: 1 }, { mode: '__proto__' }, { brightness: 256 }, { on_ms: 0 }, { breathe_ms: 199 }, { sos_unit_ms: 49 }, { led_duty: -1 }, { elapsed_ms: 2 ** 32 }, { uptime_ms: NaN }, { pin: 49 }]) {
    assert.equal(statusConfig({ ...status, ...invalid }), null);
  }
  assert.equal(validConfig({ ...DEFAULTS, brightness: 1.2 }), false);
});

test('favorites survive reload and reject corrupt, duplicate or injected records', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(readFavorites(storage), []);
  const items = [{ id: 'a', name: '夜间呼吸', config: { ...DEFAULTS, mode: 'breathe', brightness: 60 } }];
  writeFavorites(storage, items);
  assert.deepEqual(readFavorites(storage), items);
  writeFavorites(storage, []);
  assert.deepEqual(readFavorites(storage), []);
  data.set(FAVORITES_KEY, '{broken');
  assert.throws(() => readFavorites(storage));
  writeFavorites(storage, [items[0], items[0]]);
  assert.throws(() => readFavorites(storage));
  writeFavorites(storage, [{ ...items[0], config: { ...DEFAULTS, mode: 'constructor' } }]);
  assert.throws(() => readFavorites(storage));
  assert.throws(() => writeFavorites({ setItem() { throw new Error('Quota'); } }, items), /Quota/);
});

function mockSession(respond, timeoutMs = 100) {
  let input;
  const writes = [], logs = [], states = [], lost = [];
  const port = {
    readable: new ReadableStream({ start(controller) { input = controller; } }),
    writable: new WritableStream({ write(bytes) {
      const command = new TextDecoder().decode(bytes).trim();
      writes.push(command);
      respond?.(command, emit);
    } }),
    async open(options) { assert.equal(options.baudRate, 115200); },
    async close() { this.didClose = true; },
  };
  function emit(text) { input.enqueue(new TextEncoder().encode(text)); }
  const session = new SerialSession(port, { onStatus: s => states.push(s), onLog: (...args) => logs.push(args), onLost: e => lost.push(e), timeoutMs });
  return { session, port, emit, writes, states, lost, logs };
}

test('serial queues commands and parses fragmented CRLF state reports', async () => {
  const mock = mockSession((command, emit) => {
    if (command === 'STATUS') {
      const line = `STATUS ${JSON.stringify(status)}\r\n`;
      emit(line.slice(0, 15)); emit(line.slice(15));
    } else emit(`OK ${command}\n`);
  });
  await mock.session.open();
  await Promise.all([mock.session.command('BREATHE 3000'), mock.session.command('BRIGHT 80'), mock.session.command('STATUS')]);
  assert.deepEqual(mock.writes, ['BREATHE 3000', 'BRIGHT 80', 'STATUS']);
  assert.equal(mock.states.length, 1);
  await mock.session.close();
  assert.equal(mock.port.didClose, true);
  assert.equal(mock.port.readable.locked, false);
  assert.equal(mock.port.writable.locked, false);
});

test('device errors reject only the affected command', async () => {
  const mock = mockSession((command, emit) => emit(command === 'SOS bad' ? 'ERR invalid command\n' : 'PONG\n'));
  await mock.session.open();
  await assert.rejects(mock.session.command('SOS bad'), /ERR invalid/);
  assert.equal(await mock.session.command('PING'), 'PONG');
  assert.equal(mock.lost.length, 0);
  await mock.session.close();
});

test('timeouts terminate the session so late acknowledgements cannot confirm later commands', async () => {
  const mock = mockSession((_, emit) => emit('OK BRIGHT 50\n'), 25);
  await mock.session.open();
  const first = mock.session.command('BRIGHT 80');
  const second = mock.session.command('BRIGHT 90');
  await Promise.all([assert.rejects(first, /超时/), assert.rejects(second, /断开/)]);
  mock.emit('OK BRIGHT 80\n');
  assert.equal(mock.lost.length, 1);
  assert.deepEqual(mock.writes, ['BRIGHT 80']);
  await mock.session.close();
});

test('invalid STATUS cannot finish the handshake', async () => {
  const mock = mockSession((_, emit) => emit('STATUS {"version":1}\n'), 25);
  await mock.session.open();
  await assert.rejects(mock.session.command('STATUS'), /超时/);
  assert.equal(mock.states.length, 0);
  assert.equal(mock.session.status, null);
  await mock.session.close();
});

test('old firmware reports a clear upload instruction instead of an unexplained handshake failure', async () => {
  const mock = mockSession((_, emit) => emit('ERR unknown command: STATUS\n'));
  await mock.session.open();
  await assert.rejects(mock.session.command('STATUS'), /旧版固件.*make upload.*v2/);
  assert.equal(mock.session.status, null);
  assert.equal(mock.lost.length, 0);
  await mock.session.close();
});

test('a blocked USB write cannot prevent timeout or session cleanup', async () => {
  const mock = mockSession(undefined, 25);
  let finishWrite;
  mock.port.writable = new WritableStream({ write: () => new Promise(resolve => { finishWrite = resolve; }) });
  await mock.session.open();
  await assert.rejects(mock.session.command('PING'), /超时/);
  await mock.session.close();
  assert.equal(mock.lost.length, 1);
  assert.equal(mock.port.didClose, true);
  assert.equal(mock.port.writable.locked, false);
  finishWrite();
});

test('disconnect rejects pending and queued work and releases stream locks', async () => {
  const mock = mockSession();
  await mock.session.open();
  const first = mock.session.command('PING');
  const second = mock.session.command('STATUS');
  const rejected = Promise.all([assert.rejects(first, /断开/), assert.rejects(second, /断开/)]);
  await new Promise(resolve => setTimeout(resolve, 0));
  await mock.session.close();
  await rejected;
  assert.equal(mock.port.readable.locked, false);
  assert.equal(mock.port.writable.locked, false);
});

test('Wi-Fi provisioning encodes Chinese names and whitespace without exposing credentials in logs', async () => {
  const command = wifiConfigCommand('桌面 WiFi', 'pass word');
  assert.equal(command, 'WIFI SET e6a18ce99da22057694669 7061737320776f7264');
  assert.equal(wifiConfigCommand('Open', ''), 'WIFI SET 4f70656e -');
  for (const [ssid, password] of [['', 'password'], ['中'.repeat(11), 'password'], ['a\0b', 'password'], ['WiFi', 'short'], ['WiFi', '中文密码1234'], ['WiFi', 'g'.repeat(64)]]) {
    assert.throws(() => wifiConfigCommand(ssid, password));
  }
  assert.ok(wifiConfigCommand('WiFi', 'a'.repeat(64)));
  const mock = mockSession((_, emit) => emit(`OK WIFI SET\nSTATUS ${JSON.stringify({ ...status, wifi: { state: 'connecting', ssid: '桌面 WiFi', ip: '', rssi: 0, error: '' } })}\n`));
  await mock.session.open();
  assert.equal(await mock.session.command(command), 'OK WIFI SET');
  assert.deepEqual(mock.writes, [command]);
  assert.ok(mock.logs.some(([kind, text]) => kind === 'tx' && text === 'WIFI SET [凭据已隐藏]'));
  assert.ok(mock.logs.every(([, text]) => !text.includes('7061737320776f7264') && !text.includes('pass word')));
  await mock.session.close();
});

test('even a legacy firmware error echo cannot leak Wi-Fi credentials', async () => {
  const mock = mockSession((command, emit) => emit(`ERR unknown command: ${command}\n`));
  await mock.session.open();
  await assert.rejects(mock.session.command(wifiConfigCommand('Desk', 'password')), error => {
    assert.ok(!error.message.includes('70617373776f7264'));
    return true;
  });
  assert.ok(mock.logs.every(([, text]) => !text.includes('70617373776f7264')));
  await mock.session.close();
});

test('network telemetry accepts valid connection states and rejects corrupt values', () => {
  const wifi = { state: 'connected', ssid: 'Desk', ip: '192.168.1.42', rssi: -54, error: '' };
  assert.deepEqual(wifiStatus(wifi), wifi);
  assert.equal(wifiStatus(undefined), null);
  for (const patch of [{ state: '__proto__' }, { ip: '999.1.1.1' }, { rssi: 1 }, { ssid: 'x'.repeat(33) }, { error: null }]) assert.equal(wifiStatus({ ...wifi, ...patch }), null);
  // Wi-Fi extends v2 STATUS without breaking existing LED-only firmware.
  assert.deepEqual(statusConfig({ ...status, wifi }), DEFAULTS);
});

test('scan results preserve names, sort by signal, deduplicate and reject malformed records', () => {
  const networks = [
    { ssid: '桌面 WiFi', rssi: -80, secure: true },
    { ssid: 'Cafe', rssi: -50, secure: false },
    { ssid: '桌面 WiFi', rssi: -40, secure: true },
  ];
  const result = wifiScanResult({ error: '', truncated: false, networks });
  assert.deepEqual(result.networks, [networks[2], networks[1]]);
  for (const invalid of [null, { error: '', truncated: false, networks: null }, { error: '', truncated: false, networks: Array(21).fill(networks[0]) }, { error: 'unexpected', truncated: false, networks: [] }]) assert.equal(wifiScanResult(invalid), null);
  for (const patch of [{ ssid: '' }, { ssid: '中'.repeat(11) }, { ssid: 'a\0b' }, { rssi: 1 }, { secure: 'true' }]) assert.equal(wifiScanResult({ error: '', truncated: false, networks: [{ ...networks[0], ...patch }] }), null);
});

test('background scan data cannot acknowledge a pending LED command and handles large fragmented lists', async () => {
  let scan;
  const networks = Array.from({ length: 20 }, (_, index) => ({ ssid: `${index}${'\u0001'.repeat(28)}`, rssi: -40 - index, secure: true }));
  const line = `WIFI_SCAN ${JSON.stringify({ error: '', truncated: false, networks })}\n`;
  assert.ok(line.length > 2048);
  const mock = mockSession((command, emit) => {
    if (command === 'WIFI SCAN') emit('OK WIFI SCAN\n');
    else { emit(line.slice(0, 2100)); emit(line.slice(2100)); emit(`OK ${command}\n`); }
  });
  mock.session.onScan = value => { scan = value; };
  await mock.session.open();
  assert.equal(await mock.session.command('WIFI SCAN'), 'OK WIFI SCAN');
  assert.equal(await mock.session.command('BRIGHT 80'), 'OK BRIGHT 80');
  assert.equal(scan.networks.length, 20);
  assert.equal(mock.lost.length, 0);
  mock.emit('WIFI_SCAN {broken}\n');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(mock.logs.some(([kind, text]) => kind === 'err' && /扫描结果无效/.test(text)));
  assert.equal(mock.lost.length, 0);
  await mock.session.close();
});

test('favorites can be saved on plain HTTP where randomUUID is unavailable', () => {
  assert.equal(favoriteId({ randomUUID: () => 'native-id' }), 'native-id');
  const id = favoriteId({ getRandomValues: bytes => bytes.fill(255) });
  assert.equal(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

function mockHttp(respond, options = {}) {
  const requests = [], states = [], logs = [], lost = [];
  const session = new HttpSession('http://192.168.1.42', {
    onStatus: value => states.push(value), onLog: (...args) => logs.push(args), onLost: error => lost.push(error),
    pollMs: 0, timeoutMs: 100, ...options,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const response = await respond(url, init);
      return { ok: true, status: 200, json: async () => response, ...response?.http };
    },
  });
  return { session, requests, states, logs, lost };
}

test('HTTP commands and polling are serialized and update confirmed device state', async () => {
  let current = { ...status };
  let active = 0;
  const mock = mockHttp(async (url, init) => {
    assert.equal(++active, 1);
    await new Promise(resolve => setTimeout(resolve, 2));
    let result = current;
    if (url.endsWith('/api/command')) {
      const command = new URLSearchParams(init.body).get('command');
      current = { ...current, brightness: Number(command.split(' ')[1]) };
      result = { ok: true, reply: `OK ${command}`, status: current };
    }
    --active;
    return result;
  });
  await mock.session.open();
  await Promise.all([mock.session.command('BRIGHT 80'), mock.session.command('STATUS'), mock.session.command('BRIGHT 90')]);
  assert.equal(mock.session.status.brightness, 90);
  assert.deepEqual(mock.requests.map(({ url }) => url.split('/api/')[1]), ['status', 'command', 'status', 'command']);
  assert.equal(mock.states.at(-1).brightness, 90);
  await assert.rejects(mock.session.command('WIFI SET secret secret'), /USB/);
  assert.ok(mock.logs.every(([, text]) => !text.includes('secret')));
  await mock.session.close();
});

test('HTTP command rejection keeps the session usable but invalid status terminates it', async () => {
  const mock = mockHttp(async url => url.endsWith('/api/command') ? { error: 'invalid command', http: { ok: false, status: 400 } } : status);
  await mock.session.open();
  await assert.rejects(mock.session.command('SOS bad'), /invalid command/);
  assert.equal(mock.lost.length, 0);
  await mock.session.command('STATUS');
  await mock.session.close();
  const invalid = mockHttp(async () => ({ ...status, version: 1 }));
  await assert.rejects(invalid.session.open(), /不兼容/);
  assert.equal(invalid.lost.length, 1);
  assert.equal(invalid.session.status, null);
  await invalid.session.close();
});

test('HTTP timeout and disconnect cancel active work without retrying mutations', async () => {
  const respond = async (_, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const mock = mockHttp(respond, { timeoutMs: 25 });
  const first = mock.session.command('BRIGHT 80');
  const second = mock.session.command('BRIGHT 90');
  await Promise.all([assert.rejects(first, /超时/), assert.rejects(second, /断开/)]);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.lost.length, 1);
  await mock.session.close();
  const closing = mockHttp(respond);
  const pending = closing.session.command('STATUS');
  const rejected = assert.rejects(pending, /断开/);
  await new Promise(resolve => setTimeout(resolve, 0));
  await closing.session.close();
  await rejected;
  assert.equal(closing.lost.length, 0);
});

const { DESK_DEFAULTS, citySearchQuery, locationCommand, todoCommand, reminderEpoch, localDate, deskStatus, weatherName } = await import('../web/desk.mjs');
const deskData = { supported: true, display_present: true, ...DESK_DEFAULTS, epoch: 1791676800, page: 0, alarm: -1, todos: Array.from({ length: 6 }, () => ({ text: '', due: 0, done: false, dismissed: false })), weather: { valid: false, updated: 0, temperature: 0, code: 0, error: '', days: Array.from({ length: 3 }, () => ({ date: '', code: 0, low: 0, high: 0 })) } };

test('desk commands preserve Chinese and respect the firmware byte limits', () => {
  assert.equal(citySearchQuery('中国湖南长沙市'), 'Changsha');
  assert.equal(citySearchQuery('London'), 'London');
  assert.equal(locationCommand(DESK_DEFAULTS), 'DESK LOCATION 28.228200 112.938800 480 e995bfe6b299');
  assert.equal(todoCommand(0, '喝水'), 'DESK TODO 0 0 e5969de6b0b4');
  assert.ok(todoCommand(5, '中'.repeat(24), 1791676800).length < 256);
  for (const text of ['', '中'.repeat(25), 'a\nb', 'a\0b', '\ud800']) assert.throws(() => todoCommand(0, text));
  for (const slot of [-1, 6, 0.5]) assert.throws(() => todoCommand(slot, 'x'));
  assert.throws(() => locationCommand({ ...DESK_DEFAULTS, latitude: NaN }));
  assert.throws(() => locationCommand({ ...DESK_DEFAULTS, offset: 480.5 }));
});

test('reminders use the selected device timezone regardless of browser timezone', () => {
  const epoch = reminderEpoch('2026-10-11T09:00', 480);
  assert.equal(new Date(epoch * 1000).toISOString(), '2026-10-11T01:00:00.000Z');
  assert.equal(localDate(epoch, 480), '2026-10-11 09:00');
  assert.equal(reminderEpoch('2026-10-11T09:00', -300), epoch + 780 * 60);
  assert.equal(reminderEpoch('', 480), 0);
  for (const date of ['2026-02-30T09:00', 'bad', '2023-01-01T09:00']) assert.throws(() => reminderEpoch(date, 480));
});

test('desk status validates optional extension without breaking older firmware', () => {
  assert.equal(deskStatus(deskData), deskData);
  assert.equal(deskStatus(undefined), null);
  for (const patch of [{ alarm: 6 }, { todos: [] }, { epoch: -1 }, { page: 4 }, { offset: 999 }, { weather: { ...deskData.weather, temperature: NaN } }]) assert.equal(deskStatus({ ...deskData, ...patch }), null);
  assert.deepEqual(statusConfig({ ...status, desk: deskData }), DEFAULTS);
  assert.equal(weatherName(0), '晴'); assert.equal(weatherName(95), '雷雨'); assert.equal(weatherName(73), '雪');
});

test('short DESK acknowledgement supports serial commands with encoded arguments', async () => {
  const mock = mockSession((command, emit) => emit(command === 'STATUS' ? `STATUS ${JSON.stringify({ ...status, desk: deskData })}\n` : 'OK DESK\n'));
  await mock.session.open();
  assert.equal(await mock.session.command(todoCommand(0, '喝水')), 'OK DESK');
  await mock.session.command('STATUS');
  assert.deepEqual(mock.session.status.desk, deskData);
  await mock.session.close();
});

test('desk writes use the HTTP command queue and return the confirmed extension', async () => {
  const mock = mockHttp(async url => url.endsWith('/api/command') ? { ok: true, reply: 'OK DESK', status: { ...status, desk: deskData } } : { ...status, desk: deskData });
  await mock.session.open();
  assert.equal(await mock.session.command(locationCommand(DESK_DEFAULTS)), 'OK DESK');
  assert.deepEqual(mock.session.status.desk, deskData);
  assert.equal(new URLSearchParams(mock.requests.at(-1).init.body).get('command'), locationCommand(DESK_DEFAULTS));
  await mock.session.close();
});

test('default HTTP transport binds native fetch to the browser global receiver', async () => {
  const original = globalThis.fetch;
  let called = false;
  try {
    globalThis.fetch = async function () { assert.equal(this, globalThis); called = true; return { ok: true, json: async () => status }; };
    const session = new HttpSession('http://192.168.1.42', { onStatus() {}, onLog() {}, onLost() {}, pollMs: 0 });
    await session.open();
    assert.equal(called, true);
    await session.close();
  } finally { globalThis.fetch = original; }
});


const { decodeScreen, screenPixels, screenChecksum, displayConfig, displayCommand, newerFrame, drawScreen } = await import('../web/screen.mjs');
function pixelFrame(height = 64, sequence = 1) {
  const bytes = new Uint8Array(128 * height / 8);
  bytes[0] = 0x81; bytes[127] = 0x02; bytes[128] = 1;
  bytes[bytes.length - 1] = 0x80;
  return { version: 1, model: `ssd1306-128x${height}`, width: 128, height, address: 60, packing: 'page-lsb', boot_id: 123, sequence, uptime_ms: 1234, page: 3, present: false, checksum: screenChecksum(bytes), pixels: Buffer.from(bytes).toString('hex') };
}
test('frame pixels map vertical bytes exactly at page, column and screen edges', () => {
  for (const height of [32, 64]) {
    const frame = decodeScreen(pixelFrame(height));
    const pixels = screenPixels(frame);
    const on = (x, y) => pixels[(y * 128 + x) * 4] === 195;
    for (const [x, y] of [[0, 0], [0, 7], [0, 8], [127, 1], [127, height - 1]]) assert.equal(on(x, y), true);
    for (const [x, y] of [[1, 0], [0, 1], [127, 0], [127, 8]]) assert.equal(on(x, y), false);
    assert.equal(pixels.length, 128 * height * 4);
  }
});
test('frame protocol rejects corrupt, truncated and incompatible packets', () => {
  const frame = pixelFrame();
  for (const change of [{ pixels: frame.pixels.slice(2) }, { pixels: 'ff' + frame.pixels.slice(2) }, { pixels: 'xx' + frame.pixels.slice(2) }, { checksum: -1 }, { version: 2 }, { boot_id: 0 }, { model: 'tft' }, { height: 32 }, { packing: 'row-msb' }, { sequence: 0 }, { uptime_ms: NaN }, { page: 5 }, { present: 1 }, { address: 62 }]) assert.equal(decodeScreen({ ...frame, ...change }), null);
  assert.equal(decodeScreen(null), null);
  assert.equal(displayConfig(frame).width, 128);
  assert.equal(displayCommand('sh1106-128x64', 61), 'DESK DISPLAY sh1106-128x64 61');
  assert.throws(() => displayCommand('tft', 60));
});
test('canvas paints device pixels using ImageData without browser text rendering', () => {
  const frame = decodeScreen(pixelFrame(32));
  let painted;
  const canvas = { style: {}, dataset: {}, setAttribute() {}, getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: data => { painted = data.data; } }) };
  drawScreen(canvas, frame);
  assert.equal(canvas.width, 128); assert.equal(canvas.height, 32);
  assert.equal(canvas.dataset.sequence, '1');
  assert.deepEqual(painted, screenPixels(frame));
});
test('frame sequence rejects duplicates and out of order delivery, allowing uint32 wrap', () => {
  assert.equal(newerFrame({ sequence: 10 }, { sequence: 10 }), false);
  assert.equal(newerFrame({ sequence: 9 }, { sequence: 10 }), false);
  assert.equal(newerFrame({ sequence: 11 }, { sequence: 10 }), true);
  assert.equal(newerFrame({ sequence: 1 }, { sequence: 0xffffffff }), true);
  assert.equal(newerFrame({ sequence: 1 }, null), true);
  assert.equal(newerFrame({ boot_id: 2, sequence: 1 }, { boot_id: 1, sequence: 100 }), true);
});
test('serial frames can arrive fragmented without acknowledging another command', async () => {
  const frame = pixelFrame(); let received;
  const mock = mockSession((command, emit) => {
    const packet = `SCREEN ${JSON.stringify(frame)}\n`;
    emit(packet.slice(0, 100)); emit(packet.slice(100)); emit('PONG\n');
  });
  mock.session.onFrame = value => { received = value; };
  await mock.session.open();
  assert.equal(await mock.session.command('PING'), 'PONG');
  assert.deepEqual(received, frame);
  assert.equal(mock.lost.length, 0);
  await mock.session.close();
});
test('HTTP polls the real framebuffer in the serialized session and validates its checksum', async () => {
  const frame = pixelFrame(); let received;
  const mock = mockHttp(async url => url.endsWith('/api/screen') ? frame : { ...status, display: displayConfig(frame) }, { onFrame: value => { received = value; } });
  await mock.session.open();
  assert.deepEqual(received, frame);
  assert.deepEqual(mock.requests.map(r => r.url.split('/api/')[1]), ['status', 'screen']);
  await mock.session.close();
  const bad = mockHttp(async url => url.endsWith('/api/screen') ? { ...frame, checksum: 0 } : { ...status, display: displayConfig(frame) }, { onFrame() {} });
  await assert.rejects(bad.session.open(), /像素帧无效/);
  assert.equal(bad.lost.length, 1); await bad.session.close();
});

test('HTTP retries transient reads once without retrying device mutations', async () => {
  let attempts = 0;
  const read = mockHttp(async () => { if (++attempts === 1) throw new Error('hotspot delay'); return status; });
  await read.session.open(); assert.equal(attempts, 2); assert.equal(read.lost.length, 0);
  await read.session.close();
  let writes = 0;
  const mutation = mockHttp(async url => { if (url.endsWith('/api/command')) { writes++; throw new Error('connection lost'); } return status; });
  await mutation.session.open();
  await assert.rejects(mutation.session.command('DESK PAGE 3'), /connection lost/);
  assert.equal(writes, 1); assert.equal(mutation.lost.length, 1);
  await mutation.session.close();
});
