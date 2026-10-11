import { DEFAULTS, MODE_NAMES, SOS_SEGMENTS, statusConfig, dutyAt, cycleMs, modeCommand, describe } from './effects.mjs';
import { SerialSession } from './serial.mjs';
import { MAX_FAVORITES, readFavorites, writeFavorites } from './favorites.mjs';
import { WIFI_STATES, WIFI_ERRORS, wifiConfigCommand, wifiStatus } from './wifi.mjs';

const $ = id => document.getElementById(id);
const inputs = { onMs: $('onMs'), offMs: $('offMs'), brightness: $('bright'), breatheMs: $('breatheMs'), sosUnitMs: $('sosUnitMs') };
const numbers = Object.fromEntries([...document.querySelectorAll('[data-config-key]')].map(input => [input.dataset.configKey, input]));
const editingNumbers = new Set();
const MODE_CODES = { blink: 'BLINK', breathe: 'BREATHE', sos: 'MORSE / SOS', on: 'STEADY ON', off: 'LIGHT OFF' };
const supported = 'serial' in navigator;
let config = { ...DEFAULTS };
let session = null, connected = false, connecting = false, closing = false;
let device = null, lastStatusAt = 0, previewAnchor = performance.now();
let desired = null, sendTimer = null, applying = false, operationError = '';
let favorites = [];
let waveSignature = '';
let paintedDuty = -1;
let networkStatus = null, wifiBusy = false;
let wifiScanning = false, wifiScanTimer = null, nearbyNetworks = [];

function receiveScan(result, owner) {
  if (session !== owner || !wifiScanning) return;
  clearTimeout(wifiScanTimer);
  wifiScanTimer = null;
  wifiScanning = false;
  nearbyNetworks = result.networks;
  $('wifiScanNotice').textContent = result.error ? '扫描失败，请稍后重试。' : !nearbyNetworks.length ? '未找到可见网络，可重新扫描或手动输入隐藏网络名称。' : `发现 ${nearbyNetworks.length} 个网络，点击选择。${result.truncated ? '仅显示信号最强的扫描结果。' : ''}`;
  $('wifiNetworks').replaceChildren();
  nearbyNetworks.forEach((network, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.index = index;
    const name = document.createElement('strong');
    name.textContent = network.ssid;
    const detail = document.createElement('span');
    detail.textContent = `${network.secure ? '加密' : '开放'} · ${network.rssi} dBm`;
    button.append(name, detail);
    $('wifiNetworks').append(button);
  });
  renderWifi();
}

async function scanWifi() {
  const owner = session;
  if ($('btnWifiScan').disabled || !owner) return;
  wifiScanning = true;
  nearbyNetworks = [];
  $('wifiNetworks').replaceChildren();
  $('wifiScanNotice').textContent = '正在扫描附近的 2.4 GHz Wi-Fi…';
  wifiScanTimer = setTimeout(() => {
    wifiScanning = false;
    wifiScanTimer = null;
    if (session === owner) { $('wifiScanNotice').textContent = '扫描结果超时，请重新扫描。'; renderWifi(); }
  }, 18000);
  renderWifi();
  try { await owner.command('WIFI SCAN'); }
  catch (error) {
    clearTimeout(wifiScanTimer);
    wifiScanTimer = null;
    wifiScanning = false;
    if (session === owner) { $('wifiScanNotice').textContent = `扫描失败：${error.message}`; renderWifi(); }
  }
}

function renderWifi() {
  const ready = connected && fresh() && !!networkStatus && !closing && !wifiBusy && !wifiScanning && !networkStatus.scanning;
  for (const id of ['wifiSsid', 'wifiPassword', 'btnWifiSave', 'btnWifiConnect', 'btnWifiOff', 'btnWifiClear']) $(id).disabled = !ready;
  $('btnWifiConnect').disabled = !ready || !networkStatus?.ssid;
  $('btnWifiScan').disabled = !ready || networkStatus?.scan_supported !== true || networkStatus?.state === 'connecting';
  $('btnWifiScan').textContent = wifiScanning || networkStatus?.scanning ? '扫描中…' : '扫描附近 Wi-Fi';
  $('btnWifiScan').title = networkStatus && networkStatus.scan_supported !== true ? '请更新固件以支持扫描' : networkStatus?.state === 'connecting' ? '等待本次连接完成后再扫描' : '';
  for (const button of $('wifiNetworks').children) {
    button.disabled = !ready;
    const selected = nearbyNetworks[Number(button.dataset.index)]?.ssid === $('wifiSsid').value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected);
  }
  $('wifiState').textContent = !connected ? '连接 USB 串口后配网' : !fresh() ? '设备回报过期' : !networkStatus ? '固件尚不支持 Wi-Fi，请先运行 make upload' : WIFI_STATES[networkStatus.state];
  $('wifiState').classList.toggle('confirmed', connected && fresh() && networkStatus?.state === 'connected');
  $('wifiNetwork').textContent = connected && networkStatus ? networkStatus.ssid || '—' : '—';
  $('wifiIp').textContent = connected && fresh() && networkStatus?.ip ? networkStatus.ip : '—';
  $('wifiSignal').textContent = connected && fresh() && networkStatus?.state === 'connected' ? `${networkStatus.rssi} dBm` : '—';
  $('wifiError').textContent = connected && fresh() && networkStatus?.error ? WIFI_ERRORS[networkStatus.error] || '网络连接异常' : '';
}

async function applyWifi(command) {
  const owner = session;
  if (!owner || !connected || !fresh() || !networkStatus || wifiBusy) return;
  wifiBusy = true;
  $('wifiNotice').textContent = '';
  renderWifi();
  try {
    await owner.command(command);
    await owner.command('STATUS');
    if (session === owner && connected) {
      $('wifiNotice').textContent = command.startsWith('WIFI SET ') ? '配置已保存到 ESP32，正在连接；实际结果见上方状态。' : '设备已接受操作。';
      if (command === 'WIFI CLEAR') $('wifiSsid').value = '';
    }
  } catch (error) {
    if (session === owner) $('wifiNotice').textContent = `操作失败：${error.message}`;
  } finally {
    wifiBusy = false;
    renderWifi();
  }
}

function log(kind, message) {
  const entry = document.createElement('div');
  entry.className = kind;
  const timestamp = document.createElement('time');
  timestamp.dateTime = new Date().toISOString();
  timestamp.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const tag = document.createElement('span');
  tag.className = 'entry-tag';
  tag.textContent = { tx: 'TX', rx: 'RX', sys: 'SYS', err: 'ERR' }[kind];
  const body = document.createElement('span');
  body.className = 'entry-message';
  body.textContent = message;
  entry.append(timestamp, tag, body);
  $('log').append(entry);
  while ($('log').children.length > 200) $('log').firstElementChild.remove();
  $('logCount').textContent = `${$('log').children.length} 条`;
  $('log').scrollTop = $('log').scrollHeight;
}

function fresh() {
  return !!device && performance.now() - lastStatusAt < 3500;
}

function pending() {
  return applying || !!desired || sendTimer !== null;
}

function renderControls() {
  for (const [key, input] of Object.entries(inputs)) {
    input.value = config[key];
    input.disabled = connecting || closing;
    input.style.setProperty('--fill', `${(config[key] - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
    if (!editingNumbers.has(key)) numbers[key].value = config[key];
    numbers[key].disabled = connecting || closing;
  }
  for (const button of $('modeSeg').children) {
    const active = button.dataset.mode === config.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
    button.disabled = connecting || closing;
  }
  $('blinkControls').hidden = config.mode !== 'blink';
  $('breatheControls').hidden = config.mode !== 'breathe';
  $('sosControls').hidden = config.mode !== 'sos';
  $('staticControls').hidden = !['on', 'off'].includes(config.mode);
  $('staticIcon').setAttribute('href', config.mode === 'off' ? '#icon-off' : '#icon-on');
  $('staticDescription').textContent = config.mode === 'off' ? '灯光已关闭。切换模式即可重新点亮。' : '持续点亮，亮度由下方调节。';
  $('brightnessPercent').firstChild.nodeValue = Math.round(config.brightness / 255 * 100);
  for (const button of $('presets').children) button.disabled = connecting || closing;
  for (const button of $('favorites').querySelectorAll('button')) button.disabled = connecting || closing;
  renderSync();
}

function renderSync() {
  renderWifi();
  const waiting = pending();
  const synced = connected && fresh();
  document.documentElement.dataset.connection = connecting ? 'connecting' : !connected ? 'offline' : synced ? 'live' : 'stale';
  $('previewBadge').textContent = connecting ? '等待设备' : !connected ? '离线预览' : synced ? '设备预览' : '回报过期';
  $('dot').classList.toggle('on', connected);
  $('status').textContent = closing ? '正在断开…' : connecting ? '正在连接并读取状态…' : connected ? '已连接 · USB 串口' : supported ? '未连接' : '浏览器不支持 Web Serial';
  const syncText = connecting ? '等待设备状态…' : !connected ? '离线 · 可预览和收藏' : operationError ? `未完成：${operationError}` : waiting ? '命令发送中 · 等待设备确认…' : synced ? '已确认 · 设备每秒回报' : '状态超时 · 请读取状态或重新连接';
  if ($('syncStatus').textContent !== syncText) $('syncStatus').textContent = syncText;
  $('syncStatus').classList.toggle('confirmed', synced && !waiting && !operationError);
  $('btnConnect').disabled = !supported || !!session || connecting || closing;
  $('btnDisconnect').disabled = !session || connecting || closing;
  $('btnRefresh').disabled = !connected || waiting || closing;
  $('btnSaveFavorite').disabled = connecting || closing || (!!session && (!synced || waiting || !!operationError));
  if (!connected && !connecting) {
    $('previewCaption').textContent = `离线模拟 · ${MODE_NAMES[config.mode]}`;
  } else if (device) {
    $('previewCaption').textContent = fresh() ? `设备相位预览 · ${MODE_NAMES[device.mode]}` : '回报已过期 · 预览暂停';
  } else $('previewCaption').textContent = '等待设备回报…';
}

function receiveStatus(status, owner) {
  if (session !== owner) return;
  const confirmed = statusConfig(status);
  if (!confirmed) return;
  device = { ...confirmed, elapsedMs: status.elapsed_ms, duty: status.led_duty };
  networkStatus = wifiStatus(status.wifi);
  lastStatusAt = performance.now();
  // Use only the cycle phase, so long uptimes do not reduce preview precision.
  previewAnchor = lastStatusAt - status.elapsed_ms % cycleMs(confirmed);
  $('deviceMode').textContent = MODE_NAMES[confirmed.mode];
  $('deviceBright').textContent = `${confirmed.brightness} / 255`;
  $('deviceDuty').textContent = `${status.led_duty} / 255`;
  $('deviceUptime').textContent = `${Math.floor(status.uptime_ms / 1000)} s`;
  $('deviceDetail').textContent = `GPIO ${status.pin} · ${describe(confirmed)}`;
  if (!pending()) {
    config = { ...confirmed };
    renderControls();
  } else renderSync();
}

async function connect() {
  if (!supported || session || connecting || closing) return;
  connecting = true;
  operationError = '';
  renderControls();
  let owner;
  try {
    const port = await navigator.serial.requestPort();
    owner = new SerialSession(port, {
      onStatus: status => receiveStatus(status, owner),
      onScan: result => receiveScan(result, owner),
      onLog: log,
      onLost: error => {
        if (session === owner) {
          log('err', error.message);
          void disconnect();
        }
      },
    });
    session = owner;
    device = null;
    networkStatus = null;
    $('wifiNotice').textContent = '';
    for (const id of ['deviceMode', 'deviceBright', 'deviceDuty', 'deviceUptime']) $(id).textContent = '—';
    $('deviceDetail').textContent = '连接后读取设备当前状态。';
    await owner.open();
    // USB opening may reset ESP32. Never send the offline draft on connect.
    await new Promise(resolve => setTimeout(resolve, 1200));
    if (session !== owner || owner.closed || owner.failed) return;
    await owner.command('STATUS');
    if (session !== owner || owner.closed || owner.failed) return;
    connected = true;
    log('sys', '已读取设备状态。控件现在反映板子实际设定。');
  } catch (error) {
    if (error.name === 'NotFoundError') log('sys', '已取消串口选择。');
    else log('err', `连接失败：${error.message}`);
    if (owner && session === owner) await disconnect();
  } finally {
    connecting = false;
    renderControls();
  }
}

async function disconnect() {
  if (closing) return;
  const owner = session;
  closing = true;
  connected = false;
  clearTimeout(sendTimer);
  sendTimer = null;
  desired = null;
  if (device) config = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, device[key]]));
  device = null;
  networkStatus = null;
  clearTimeout(wifiScanTimer);
  wifiScanTimer = null;
  wifiScanning = false;
  nearbyNetworks = [];
  $('wifiNetworks').replaceChildren();
  $('wifiScanNotice').textContent = '';
  $('wifiPassword').value = '';
  previewAnchor = performance.now();
  $('deviceDetail').textContent = '已断开 · 上方为最后一次设备回报。';
  renderControls();
  if (owner) await owner.close();
  if (session === owner) session = null;
  closing = false;
  renderControls();
}

function modeChanged(a, b) {
  if (!a || a.mode !== b.mode) return true;
  if (b.mode === 'blink') return a.on_ms !== b.onMs || a.off_ms !== b.offMs;
  if (b.mode === 'breathe') return a.breathe_ms !== b.breatheMs;
  if (b.mode === 'sos') return a.sos_unit_ms !== b.sosUnitMs;
  return false;
}

async function flushChanges() {
  sendTimer = null;
  if (applying || !connected || !session) return;
  const owner = session;
  applying = true;
  renderSync();
  try {
    while (desired && session === owner && connected) {
      const target = desired;
      desired = null;
      const confirmed = owner.status;
      if (confirmed?.brightness !== target.brightness) await owner.command(`BRIGHT ${target.brightness}`);
      if (modeChanged(confirmed, target)) await owner.command(modeCommand(target));
      // ACK means accepted; STATUS confirms output and anchors the preview.
      await owner.command('STATUS');
    }
  } catch (error) {
    desired = null;
    clearTimeout(sendTimer);
    sendTimer = null;
    operationError = error.message;
    log('err', `应用失败：${error.message}`);
    if (session === owner && !owner.closed && !owner.failed) {
      try { await owner.command('STATUS'); } catch (_) {}
    }
  } finally {
    applying = false;
    if (session === owner && owner.status && !desired) config = statusConfig(owner.status);
    renderControls();
  }
}

function edit(next, immediate = false, resetPhase = true) {
  if (connecting || closing) return;
  config = { ...config, ...next };
  operationError = '';
  if (connected) {
    desired = { ...config };
    clearTimeout(sendTimer);
    sendTimer = setTimeout(flushChanges, immediate ? 0 : 120);
  } else if (resetPhase) previewAnchor = performance.now();
  renderControls();
}

function paintLed(duty) {
  if (duty === paintedDuty) return;
  paintedDuty = duty;
  const b = duty / 255;
  const dark = [35, 39, 46], light = [255, 213, 74];
  $('led').style.background = `rgb(${dark.map((value, i) => Math.round(value + (light[i] - value) * b)).join(',')})`;
  $('led').style.boxShadow = b > 0 ? `0 0 ${48 * b}px rgba(255,213,74,${0.7 * b}), inset 0 0 12px rgba(255,255,255,${0.35 * b})` : 'inset 0 4px 14px rgba(0,0,0,.6)';
  $('ledGlow').style.opacity = `${0.75 * b}`;
}

function drawWaveform(effect) {
  const signature = Object.keys(DEFAULTS).map(key => effect[key]).join('|');
  if (signature === waveSignature) return;
  waveSignature = signature;
  const y = duty => (40 - duty / 255 * 34).toFixed(2);
  const period = cycleMs(effect);
  let path;
  if (effect.mode === 'blink') {
    path = `M0 ${y(effect.brightness)}H${(effect.onMs / period * 440).toFixed(2)}V40H440`;
  } else if (effect.mode === 'sos') {
    let position = 0;
    path = `M0 ${y(effect.brightness)}`;
    SOS_SEGMENTS.forEach((units, index) => {
      position += units;
      path += `H${(position / 34 * 440).toFixed(2)}`;
      if (index < SOS_SEGMENTS.length - 1) path += `V${y(index % 2 === 0 ? 0 : effect.brightness)}`;
    });
  } else if (effect.mode === 'breathe') {
    path = Array.from({ length: 161 }, (_, index) => `${index ? 'L' : 'M'}${(index / 160 * 440).toFixed(2)} ${y(dutyAt(effect, index / 160 * period))}`).join('');
  } else path = `M0 ${y(effect.mode === 'on' ? effect.brightness : 0)}H440`;
  $('wavePath').setAttribute('d', path);
  $('waveArea').setAttribute('d', `${path}L440 46L0 46Z`);
  $('waveChart').setAttribute('aria-label', `${MODE_NAMES[effect.mode]}灯效周期曲线`);
  $('previewMode').textContent = MODE_NAMES[effect.mode];
  $('previewModeCode').textContent = MODE_CODES[effect.mode];
  $('cycleLabel').textContent = effect.mode === 'on' ? '持续输出' : effect.mode === 'off' ? '输出已关闭' : `${(period / 1000).toFixed(2)} s / 周期`;
  $('waveCursor').setAttribute('visibility', ['on', 'off'].includes(effect.mode) ? 'hidden' : 'visible');
}

function animate(now) {
  if (session) {
    // Pause at the last reported output when reports stop arriving.
    paintLed(device ? fresh() ? dutyAt(device, now - previewAnchor) : device.duty : 0);
  } else paintLed(dutyAt(config, now - previewAnchor));
  const preview = session ? device : config;
  if (preview) {
    drawWaveform(preview);
    if (!session || fresh()) {
      const cursor = ((now - previewAnchor) % cycleMs(preview)) / cycleMs(preview) * 440;
      $('waveCursor').setAttribute('x1', cursor);
      $('waveCursor').setAttribute('x2', cursor);
    }
  }
  requestAnimationFrame(animate);
}

function renderFavorites() {
  $('favorites').replaceChildren();
  $('favoriteCount').textContent = `${favorites.length} / ${MAX_FAVORITES}`;
  if (!favorites.length) {
    const note = document.createElement('div');
    note.className = 'favorite-empty';
    note.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-bookmark"/></svg><div><p>把喜欢的节奏留在这里</p><small>选好灯效和亮度，起个名字就能保存。</small></div>';
    $('favorites').append(note);
  }
  for (const item of favorites) {
    const row = document.createElement('div');
    row.className = 'favorite';
    const recall = document.createElement('button');
    recall.type = 'button';
    recall.className = 'recall';
    recall.setAttribute('aria-label', `调用收藏 ${item.name}`);
    const name = document.createElement('strong');
    name.textContent = item.name;
    const summary = document.createElement('small');
    summary.textContent = `${MODE_NAMES[item.config.mode]} · ${describe(item.config)} · 亮度 ${item.config.brightness}`;
    recall.append(name, summary);
    recall.addEventListener('click', () => edit(item.config, true));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove danger';
    remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除收藏 ${item.name}`);
    remove.addEventListener('click', () => persistFavorites(favorites.filter(saved => saved.id !== item.id), `已删除「${item.name}」。`));
    row.append(recall, remove);
    $('favorites').append(row);
  }
  renderControls();
}

function persistFavorites(items, message) {
  try {
    writeFavorites(localStorage, items);
    favorites = items;
    renderFavorites();
    $('favoriteNotice').textContent = message;
    return true;
  } catch (_) {
    $('favoriteNotice').textContent = '无法保存收藏，请允许浏览器本地存储或检查存储空间。';
    return false;
  }
}

$('favoriteForm').addEventListener('submit', event => {
  event.preventDefault();
  if ($('btnSaveFavorite').disabled) return;
  const name = $('favoriteName').value.trim();
  if (!name) { $('favoriteNotice').textContent = '请输入收藏名称。'; return; }
  if (favorites.some(item => item.name === name)) { $('favoriteNotice').textContent = '已有同名收藏，请使用另一个名称。'; return; }
  if (favorites.length >= MAX_FAVORITES) { $('favoriteNotice').textContent = `最多收藏 ${MAX_FAVORITES} 个灯效，请先删除一个。`; return; }
  const savedConfig = connected ? statusConfig(session.status) : { ...config };
  const item = { id: crypto.randomUUID(), name, config: savedConfig };
  if (persistFavorites([...favorites, item], `已收藏「${name}」。`)) $('favoriteName').value = '';
});

$('modeSeg').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (button && !button.disabled) edit({ mode: button.dataset.mode }, true);
});
for (const [key, input] of Object.entries(inputs)) {
  input.addEventListener('input', () => edit({ [key]: Number(input.value) }, false, key !== 'brightness'));
}
for (const [key, number] of Object.entries(numbers)) {
  number.inputMode = 'numeric';
  number.title = `范围 ${number.min}–${number.max}`;
  number.addEventListener('input', () => {
    editingNumbers.add(key);
    if (number.validity.valid && Number.isInteger(number.valueAsNumber)) {
      edit({ [key]: number.valueAsNumber }, false, key !== 'brightness');
    }
  });
  const commit = () => {
    const value = Number.isFinite(number.valueAsNumber) ? Math.min(Number(number.max), Math.max(Number(number.min), Math.round(number.valueAsNumber))) : config[key];
    number.value = value;
    editingNumbers.delete(key);
    if (config[key] !== value) edit({ [key]: value }, true, key !== 'brightness');
    else renderControls();
  };
  number.addEventListener('change', commit);
  number.addEventListener('blur', commit);
  number.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commit(); number.blur(); }
    if (event.key === 'Escape') { number.value = config[key]; number.blur(); }
  });
}
$('presets').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  const next = { mode: button.dataset.mode };
  for (const [attr, key] of Object.entries({ on: 'onMs', off: 'offMs', breathe: 'breatheMs', sos: 'sosUnitMs' })) {
    if (button.dataset[attr]) next[key] = Number(button.dataset[attr]);
  }
  edit(next, true);
});
$('btnConnect').addEventListener('click', connect);
$('btnWifiScan').addEventListener('click', () => void scanWifi());
$('wifiNetworks').addEventListener('click', event => {
  const button = event.target.closest('button[data-index]');
  if (!button || button.disabled) return;
  const network = nearbyNetworks[Number(button.dataset.index)];
  if (!network) return;
  $('wifiSsid').value = network.ssid;
  $('wifiPassword').value = '';
  $('wifiPassword').placeholder = network.secure ? '输入所选网络的密码' : '开放网络，无需密码';
  renderWifi();
  if (network.secure) $('wifiPassword').focus();
});
$('wifiSsid').addEventListener('input', renderWifi);
$('wifiForm').addEventListener('submit', event => {
  event.preventDefault();
  if ($('btnWifiSave').disabled) return;
  try {
    const command = wifiConfigCommand($('wifiSsid').value, $('wifiPassword').value);
    $('wifiPassword').value = '';
    void applyWifi(command);
  } catch (error) { $('wifiNotice').textContent = error.message; }
});
for (const [id, command] of Object.entries({ btnWifiConnect: 'WIFI CONNECT', btnWifiOff: 'WIFI OFF', btnWifiClear: 'WIFI CLEAR' })) {
  $(id).addEventListener('click', () => void applyWifi(command));
}
$('btnDisconnect').addEventListener('click', () => void disconnect());
$('btnRefresh').addEventListener('click', async () => {
  const owner = session;
  if (!owner || !connected || pending()) return;
  operationError = '';
  try { await owner.command('STATUS'); }
  catch (error) { log('err', error.message); }
  renderSync();
});
$('btnClear').addEventListener('click', () => {
  $('log').replaceChildren();
  $('logCount').textContent = '0 条';
});
document.querySelector('.header-meta a').addEventListener('click', () => {
  $('help').open = true;
});
if (supported) navigator.serial.addEventListener('disconnect', event => {
  if (event.target === session?.port || event.port === session?.port) {
    log('sys', '设备已拔出。');
    void disconnect();
  }
});

try { favorites = readFavorites(localStorage); }
catch (_) { $('favoriteNotice').textContent = '无法读取收藏：本地存储不可用或收藏数据已损坏。'; }
renderFavorites();
requestAnimationFrame(animate);
setInterval(renderSync, 500);
log('sys', supported ? '就绪。离线可预览；连接串口后读取设备状态。' : '请用 Chrome 或 Edge 连接设备；当前仍可预览和收藏。');
