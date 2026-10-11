const STATES = { unconfigured: '未配置服务器', waiting_wifi: '等待 Wi-Fi 联网', connecting: '正在接入服务器', connected: 'ESP32 已接入服务器', off: '服务器通道已关闭', error: '服务器接入失败' };
const ERRORS = { unauthorized: '设备密钥不匹配，请与服务器 ESP32_DEVICE_TOKEN 保持一致。', server_mode: '服务器尚未启用云端接入模式，请设置 CONTROL_MODE=cloud 并重启。', server_unreachable: '设备无法访问服务器地址，请检查地址、端口、防火墙和网络。', server_timeout: '服务器回复超时，将自动重试。', time_not_ready: 'HTTPS 需要正确时间，请等待 NTP 或用浏览器校时。', task_failed: '设备后台任务启动失败，请重启设备。', response_invalid: '服务器协议不兼容，请更新服务器。', session_conflict: '设备会话冲突，请重启服务器和设备。' };
export function cloudConfigCommand(url, token) {
  url = url.trim().replace(/\/$/, '');
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(url) || url.length > 128) throw new Error('请输入服务器根地址，例如 http://172.20.10.2:8000，不含路径或账号密码。');
  const parsed = new URL(url);
  if (['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('ESP32 的 localhost 指向板子自身，请填写电脑局域网 IP 或公网域名。');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new Error('设备密钥须为 16–64 位英文、数字、下划线或短横线，与服务器 ESP32_DEVICE_TOKEN 一致。');
  return `CLOUD SET ${url} ${token}`;
}
export function mountCloud({ getSession, isReady, usb }) {
  const $ = id => document.getElementById(id);
  let state = null, busy = false, owner = null;
  function connection() {
    const ready = usb && isReady() && state?.supported === true && !busy;
    for (const input of $('cloudProvisioning').querySelectorAll('input, button')) input.disabled = !ready;
    $('cloudState').textContent = !isReady() ? '等待设备状态' : !state ? '请升级固件以支持主动接入' : STATES[state.state] || '未知状态';
    $('cloudState').classList.toggle('confirmed', isReady() && state?.state === 'connected');
    $('cloudEndpoint').textContent = state?.url || '—';
    $('cloudError').textContent = state?.error ? ERRORS[state.error] || `接入失败：${state.error}` : '';
    $('cloudProvisioning').hidden = !usb;
  }
  async function send(command) {
    const session = getSession();
    if (!usb || !isReady() || !session || busy) return;
    busy = true; connection(); $('cloudNotice').textContent = '';
    try {
      await session.command(command); await session.command('STATUS');
      $('cloudNotice').textContent = command.startsWith('CLOUD SET ') ? '配置已保存，ESP32 正在主动连接服务器；实际结果见上方状态。' : '设备已确认。';
    } catch (error) { $('cloudNotice').textContent = `操作失败：${error.message}`; }
    finally { busy = false; connection(); }
  }
  $('cloudForm').addEventListener('submit', event => {
    event.preventDefault();
    try { const command = cloudConfigCommand($('cloudUrl').value, $('cloudToken').value); $('cloudToken').value = ''; void send(command); }
    catch (error) { $('cloudNotice').textContent = error.message; }
  });
  for (const [id, command] of Object.entries({ cloudConnect: 'CLOUD CONNECT', cloudOff: 'CLOUD OFF', cloudClear: 'CLOUD CLEAR' })) $(id).addEventListener('click', () => void send(command));
  return { connection, accept(value, session) {
    state = value?.supported === true && typeof value.url === 'string' && Object.hasOwn(STATES, value.state) && typeof value.error === 'string' ? value : null;
    if (state && owner !== session) { owner = session; $('cloudUrl').value = state.url; }
    connection();
  } };
}
