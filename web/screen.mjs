// Registry describes only drivers implemented on ESP32. Pixels and typography
// originate in firmware; the browser never reconstructs content from status.
export const SCREEN_MODELS = Object.freeze({
  'ssd1306-128x64': { width: 128, height: 64 },
  'ssd1306-128x32': { width: 128, height: 32 },
  'sh1106-128x64': { width: 128, height: 64 },
});
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
export function screenChecksum(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}
export function displayConfig(value) {
  const model = SCREEN_MODELS[value?.model];
  return model && value.width === model.width && value.height === model.height && [60, 61].includes(value.address) ? value : null;
}
export function displayCommand(model, address) {
  if (!SCREEN_MODELS[model] || ![60, 61].includes(address)) throw new Error('请选择支持的屏幕型号和 I²C 地址。');
  return `DESK DISPLAY ${model} ${address}`;
}
export function decodeScreen(value) {
  if (!displayConfig(value) || value.version !== 1 || value.packing !== 'page-lsb' || !uint32(value.boot_id) || !value.boot_id || !uint32(value.sequence) || !value.sequence || !uint32(value.uptime_ms) || !uint32(value.checksum) || !Number.isInteger(value.page) || value.page < 1 || value.page > 4 || typeof value.present !== 'boolean' || typeof value.pixels !== 'string' || value.pixels.length !== value.width * value.height / 4 || !/^[0-9a-f]+$/i.test(value.pixels)) return null;
  const bytes = Uint8Array.from(value.pixels.match(/../g), pair => parseInt(pair, 16));
  if (screenChecksum(bytes) !== value.checksum) return null;
  return { ...value, bytes };
}
// Vertical bytes: x + floor(y/8)*width, low bit at top of each 8-row page.
export function screenPixels(frame) {
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const on = frame.bytes[x + (y >> 3) * frame.width] & (1 << (y & 7));
    const i = (y * frame.width + x) * 4;
    rgba.set(on ? [195, 243, 250, 255] : [3, 8, 9, 255], i);
  }
  return rgba;
}
export function drawScreen(canvas, frame) {
  canvas.width = frame.width; canvas.height = frame.height;
  canvas.style.aspectRatio = `${frame.width} / ${frame.height}`;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(frame.width, frame.height);
  pixels.data.set(screenPixels(frame));
  context.putImageData(pixels, 0, 0);
  canvas.dataset.sequence = String(frame.sequence);
  canvas.dataset.model = frame.model;
  canvas.dataset.page = ['idle', 'clock', 'weather', 'todo', 'alarm'][frame.page];
  canvas.setAttribute('aria-label', `ESP32 屏幕帧 ${frame.sequence}，${frame.width} × ${frame.height}`);
}
// Sequence comparison also handles uint32 wrap. A new session resets history.
export function newerFrame(frame, previous) {
  if (!previous || frame.boot_id !== previous.boot_id) return true;
  const delta = (frame.sequence - previous.sequence) >>> 0;
  return delta > 0 && delta < 0x80000000;
}
