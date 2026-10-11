import { decodeScreen, drawScreen, displayConfig, displayCommand, newerFrame } from './screen.mjs';

export const DESK_DEFAULTS = { city: '长沙', latitude: 28.2282, longitude: 112.9388, offset: 480 };
export const MAX_TODOS = 6;
export function citySearchQuery(value) {
  const query = value.trim();
  // Geonames' Chinese search for 长沙 omits the Hunan capital; its romanized
  // name finds the correct city. Keep the returned province visible for selection.
  return ['长沙', '长沙市', '湖南长沙', '湖南长沙市', '湖南省长沙市', '中国湖南长沙市'].includes(query) ? 'Changsha' : query;
}
const byteLength = value => new TextEncoder().encode(value).length;
export function textHex(value, limit) {
  const text = value.trim();
  if (!text || byteLength(text) > limit || /[\x00-\x1f\x7f]/u.test(text) || /[\ud800-\udfff]/u.test(text)) throw new Error(`内容不能为空，最多 ${limit} 个 UTF-8 字节（约 ${Math.floor(limit / 3)} 个汉字）。`);
  return [...new TextEncoder().encode(text)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function locationCommand({ city, latitude, longitude, offset }) {
  if (![latitude, longitude, offset].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || !Number.isInteger(offset) || offset < -720 || offset > 840) throw new Error('请检查经纬度和 UTC 时差。');
  return `DESK LOCATION ${latitude.toFixed(6)} ${longitude.toFixed(6)} ${offset} ${textHex(city, 48)}`;
}
export function reminderEpoch(value, offset) {
  if (!value) return 0;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('提醒时间格式无效。');
  const parsed = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 16) !== value) throw new Error('提醒日期无效。');
  const epoch = parsed / 1000 - offset * 60;
  if (!Number.isInteger(epoch) || epoch < 1704067200 || epoch > 4102444799) throw new Error('提醒时间应在 2024–2099 年之间。');
  return epoch;
}
export function todoCommand(slot, text, due = 0) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_TODOS || !Number.isInteger(due) || (due !== 0 && (due < 1704067200 || due > 4102444799))) throw new Error('待办参数无效。');
  return `DESK TODO ${slot} ${due} ${textHex(text, 72)}`;
}
export function localDate(epoch, offset) {
  return new Date((epoch + offset * 60) * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
export function weatherName(code) {
  if (code === 0) return '晴';
  if (code >= 1 && code <= 3) return '多云';
  if ([45, 48].includes(code)) return '雾';
  if (code >= 95 && code <= 99) return '雷雨';
  if ((code >= 71 && code <= 77) || [85, 86].includes(code)) return '雪';
  if (code >= 51 && code <= 82) return '雨';
  return '未知';
}
export function deskStatus(value) {
  if (!value || value.supported !== true || typeof value.display_present !== 'boolean' || !Number.isInteger(value.epoch) || value.epoch < 0 || value.epoch > 4102444799 || !Number.isInteger(value.page) || value.page < 0 || value.page > 3 || !Number.isInteger(value.alarm) || value.alarm < -1 || value.alarm >= MAX_TODOS) return null;
  try { locationCommand(value); } catch (_) { return null; }
  if (!Array.isArray(value.todos) || value.todos.length !== MAX_TODOS || value.todos.some(t => !t || typeof t.text !== 'string' || byteLength(t.text) > 72 || /[\x00-\x1f\x7f]/u.test(t.text) || !Number.isInteger(t.due) || (t.due !== 0 && (t.due < 1704067200 || t.due > 4102444799)) || typeof t.done !== 'boolean' || typeof t.dismissed !== 'boolean')) return null;
  const w = value.weather;
  if (!w || typeof w.valid !== 'boolean' || typeof w.error !== 'string' || w.error.length > 32 || !Number.isInteger(w.updated) || w.updated < 0 || w.updated > 4102444799 || !Number.isFinite(w.temperature) || Math.abs(w.temperature) > 100 || !Number.isInteger(w.code) || !Array.isArray(w.days) || w.days.length !== 3) return null;
  if (w.days.some(d => !d || typeof d.date !== 'string' || (w.valid && !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) || !Number.isInteger(d.code) || !Number.isFinite(d.low) || !Number.isFinite(d.high) || Math.abs(d.low) > 100 || Math.abs(d.high) > 100)) return null;
  return value;
}

export function mountDesk({ getSession, isReady }) {
  const $ = id => document.getElementById(id);
  let state = null, owner = null, busy = false, searchController = null, signature = '', frame = null, frameAt = 0, displayDirty = false;
  const canvas = $('deskScreen');
  const notice = message => { $('deskNotice').textContent = message; };
  function ready() { return isReady() && !!state && !busy; }
  function connection() {
    const active = ready();
    for (const control of document.querySelectorAll('[data-desk-write]')) control.disabled = !active;
    $('todoFields').disabled = !active;
    for (const id of ['deskModel', 'deskAddress', 'deskApplyDisplay']) $(id).disabled = !active || !displayConfig(state?.display);
    $('deskState').textContent = !isReady() ? '连接设备后配置' : !state ? '请升级固件以支持显示器' : !frame ? '等待设备像素帧' : !frame.present ? 'ESP32 渲染中 · 未接实体屏' : '实体屏已连接';
    $('deskState').classList.toggle('confirmed', isReady() && !!frame?.present);
    paintScreen();
  }
  async function send(command) {
    const session = getSession();
    if (!ready() || !session) return false;
    busy = true; connection(); notice('正在保存到设备…');
    try {
      await session.command(command);
      await session.command('STATUS');
      if (getSession() !== session || !isReady()) return false;
      notice(command.startsWith('DESK TIME ') ? '设备时间已更新，断电后需重新校时。' : command === 'DESK REFRESH' ? '已请求刷新天气；距离上次请求不足 30 秒时会稍后执行。' : '设备已确认。配置和待办保存在板子上。');
      return true;
    } catch (error) { if (getSession() === session) notice(`操作失败：${error.message}`); return false; }
    finally { busy = false; connection(); }
  }
  function fillLocation(value) {
    for (const [id, key] of Object.entries({ deskCity: 'city', deskLatitude: 'latitude', deskLongitude: 'longitude', deskOffset: 'offset' })) $(id).value = value[key];
  }
  function paintScreen() {
    const live = isReady() && owner === getSession() && !!frame && performance.now() - frameAt < 3500;
    for (const indicator of document.querySelectorAll('[data-screen-page]')) indicator.classList.toggle('active', live && (indicator.dataset.screenPage === canvas.dataset.page || canvas.dataset.page === 'alarm' && indicator.dataset.screenPage === 'todo'));
    canvas.classList.toggle('is-alarm', live && frame.page === 4);
    canvas.classList.toggle('is-stale', !live);
    $('screenSignal').classList.toggle('live', live);
    $('screenTelemetry').textContent = frame ? `${frame.model.toUpperCase()} · ${frame.width} × ${frame.height} · #${frame.sequence}${live ? '' : ' · 已暂停'}` : '等待 ESP32 像素帧';
  }
  function acceptFrame(value, session) {
    if (session !== getSession()) return;
    const next = decodeScreen(value);
    if (!next) { notice('屏幕帧校验失败，请刷新或更新固件。'); return; }
    if (session !== owner) { owner = session; frame = null; }
    if (!newerFrame(next, frame)) return;
    frame = next; frameAt = performance.now();
    drawScreen(canvas, frame); connection();
  }
  function accept(value, session, telemetry = {}) {
    state = deskStatus(value ? { ...value, display: telemetry.display } : value);
    if (!state) { connection(); return; }
    if (session !== owner) { owner = session; frame = null; displayDirty = false; fillLocation(state); signature = ''; canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); }
    if (document.activeElement !== $('deskPage')) $('deskPage').value = state.page;
    if (displayConfig(state.display) && document.activeElement !== $('deskModel') && document.activeElement !== $('deskAddress') && !busy && !displayDirty) { $('deskModel').value = state.display.model; $('deskAddress').value = state.display.address; }
    $('deskZone').textContent = `按设备所在地时间填写 · UTC${state.offset >= 0 ? '+' : ''}${state.offset / 60}`;
    const w = state.weather;
    $('deskWeatherNote').textContent = w.valid ? `更新于 ${localDate(w.updated, state.offset)}${w.error || state.epoch - w.updated > 3600 ? ' · 数据过期，正在重试' : ''}` : w.error ? '天气获取失败，5 分钟后重试；请检查网络。' : '连接互联网并校时后自动获取天气。';
    const nextSignature = JSON.stringify([state.todos, state.alarm, state.offset]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      $('deskTodos').replaceChildren();
      state.todos.forEach((todo, slot) => {
        if (!todo.text) return;
        const row = document.createElement('div'); row.className = `desk-todo${todo.done ? ' is-done' : ''}${state.alarm === slot ? ' is-due' : ''}`;
        const check = document.createElement('button'); check.type = 'button'; check.dataset.deskWrite = ''; check.textContent = todo.done ? '✓' : '○'; check.setAttribute('aria-label', `${todo.done ? '重新打开' : '完成'} ${todo.text}`); check.addEventListener('click', () => void send(`DESK DONE ${slot} ${todo.done ? 0 : 1}`));
        const body = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
        title.textContent = todo.text;
        detail.textContent = todo.due ? `${localDate(todo.due, state.offset)}${todo.dismissed ? ' · 已确认提醒' : state.alarm === slot ? ' · 到点提醒' : ''}` : '无定时提醒'; body.append(title, detail);
        const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.deskWrite = ''; remove.textContent = '删除'; remove.addEventListener('click', () => void send(`DESK DELETE ${slot}`));
        row.append(check, body);
        if (state.alarm === slot) { const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.dataset.deskWrite = ''; dismiss.textContent = '确认提醒'; dismiss.addEventListener('click', () => void send(`DESK DISMISS ${slot}`)); row.append(dismiss); }
        row.append(remove); $('deskTodos').append(row);
      });
      if (!$('deskTodos').children.length) { const empty = document.createElement('p'); empty.className = 'parameter-note'; empty.textContent = '没有待办。留一点空间给今天。'; $('deskTodos').append(empty); }
    }
    $('deskTodoCount').textContent = `${state.todos.filter(t => t.text && !t.done).length} 未完成 / ${MAX_TODOS} 个位置`;
    paintScreen(); connection();
  }
  fillLocation(DESK_DEFAULTS);
  $('deskLocationForm').addEventListener('submit', async event => {
    event.preventDefault();
    try { await send(locationCommand({ city: $('deskCity').value, latitude: Number($('deskLatitude').value), longitude: Number($('deskLongitude').value), offset: Number($('deskOffset').value) })); }
    catch (error) { notice(error.message); }
  });
  $('deskSearch').addEventListener('click', async () => {
    searchController?.abort();
    const controller = new AbortController(); searchController = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    $('deskCities').replaceChildren(); $('deskSearchNote').textContent = '正在搜索城市…';
    try {
      const query = citySearchQuery($('deskCity').value);
      if (!query) throw new Error('请输入城市名称。');
      const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
      url.search = new URLSearchParams({ name: query, count: '6', language: 'zh', format: 'json' });
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('城市服务暂时不可用。');
      const data = await response.json();
      if (searchController !== controller) return;
      const cities = (data.results || []).filter(city => typeof city.name === 'string' && Number.isFinite(city.latitude) && Number.isFinite(city.longitude));
      $('deskSearchNote').textContent = cities.length ? '选择城市后点击「保存位置」。' : '未找到城市，可尝试拼音（如 Changsha），或手动填写经纬度。';
      for (const city of cities) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = `${city.name} · ${city.admin1 || ''} · ${city.country || ''}`;
        button.addEventListener('click', () => {
          let offset = 480;
          try { const zone = new Intl.DateTimeFormat('en', { timeZone: city.timezone, timeZoneName: 'longOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value; const match = zone.match(/GMT([+-])(\d{2}):(\d{2})/); offset = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1) : 0; } catch (_) {}
          fillLocation({ ...city, city: city.name, offset }); $('deskCities').replaceChildren(); $('deskSearchNote').textContent = '已选择，点击「保存位置」应用到设备。';
        }); $('deskCities').append(button);
      }
    } catch (error) { if (searchController === controller) $('deskSearchNote').textContent = controller.signal.aborted ? '搜索超时，可重试或手动输入经纬度。' : `搜索失败：${error.message} 可手动输入经纬度。`; }
    finally { clearTimeout(timer); }
  });
  $('deskTodoForm').addEventListener('submit', async event => {
    event.preventDefault(); if (!ready()) return;
    const slot = state.todos.findIndex(t => !t.text);
    if (slot < 0) { notice('最多保存 6 条，请先删除已完成的事项。'); return; }
    try {
      const due = reminderEpoch($('deskDue').value, state.offset);
      if (await send(todoCommand(slot, $('deskTodoText').value, due))) { $('deskTodoText').value = ''; $('deskDue').value = ''; }
    } catch (error) { notice(error.message); }
  });
  for (const id of ['deskModel', 'deskAddress']) $(id).addEventListener('change', () => { displayDirty = true; });
  $('deskDisplayForm').addEventListener('submit', async event => {
    event.preventDefault();
    try { if (await send(displayCommand($('deskModel').value, Number($('deskAddress').value)))) displayDirty = false; } catch (error) { notice(error.message); }
  });
  $('deskPage').addEventListener('change', () => void send(`DESK PAGE ${$('deskPage').value}`));
  $('deskRefresh').addEventListener('click', () => void send('DESK REFRESH'));
  $('deskSetTime').addEventListener('click', () => void send(`DESK TIME ${Math.floor(Date.now() / 1000)}`));
  setInterval(paintScreen, 250);
  connection();
  return { accept, acceptFrame, connection };
}
