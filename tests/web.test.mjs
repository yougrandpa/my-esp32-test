import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, dutyAt, statusConfig, validConfig, modeCommand } from '../web/effects.mjs';
import { FAVORITES_KEY, readFavorites, writeFavorites } from '../web/favorites.mjs';
import { SerialSession } from '../web/serial.mjs';
import { wifiConfigCommand, wifiStatus, wifiScanResult } from '../web/wifi.mjs';

const status = { version: 2, mode: 'blink', brightness: 255, on_ms: 500, off_ms: 500, breathe_ms: 3000, sos_unit_ms: 150, elapsed_ms: 0, uptime_ms: 0, led_duty: 255, pin: 2 };

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
