export const MODE_NAMES = { on: '常亮', off: '熄灭', blink: '闪烁', breathe: '呼吸', sos: 'SOS' };
export const DEFAULTS = Object.freeze({ mode: 'blink', brightness: 255, onMs: 500, offMs: 500, breatheMs: 3000, sosUnitMs: 150 });
export const SOS_SEGMENTS = [1,1,1,1,1,3,3,1,3,1,3,3,1,1,1,1,1,7];
export const LIMITS = { brightness: [0,255], onMs: [10,60000], offMs: [10,60000], breatheMs: [200,60000], sosUnitMs: [50,2000] };
export function validConfig(value) {
  return value && Object.hasOwn(MODE_NAMES, value.mode) && Object.entries(LIMITS).every(([key,[lo,hi]]) => Number.isInteger(value[key]) && value[key] >= lo && value[key] <= hi);
}
export function statusConfig(value) {
  const config = { mode: value?.mode, brightness: value?.brightness, onMs: value?.on_ms, offMs: value?.off_ms, breatheMs: value?.breathe_ms, sosUnitMs: value?.sos_unit_ms };
  const uint32 = number => Number.isInteger(number) && number >= 0 && number <= 0xffffffff;
  return value?.version === 2 && validConfig(config) && uint32(value.elapsed_ms) && Number.isInteger(value.led_duty) && value.led_duty >= 0 && value.led_duty <= 255 && Number.isInteger(value.pin) && value.pin >= 0 && value.pin <= 48 && uint32(value.uptime_ms) ? config : null;
}
export function cycleMs(config) {
  return config.mode === 'breathe' ? config.breatheMs : config.mode === 'sos' ? config.sosUnitMs * 34 : config.onMs + config.offMs;
}
export function dutyAt(config, elapsed) {
  const elapsedMs = Math.max(0, elapsed);
  if (config.mode === 'off') return 0;
  if (config.mode === 'on') return config.brightness;
  if (config.mode === 'blink') return elapsedMs % (config.onMs + config.offMs) < config.onMs ? config.brightness : 0;
  if (config.mode === 'breathe') return Math.round(config.brightness * (0.5 - 0.5 * Math.cos((elapsedMs % config.breatheMs) / config.breatheMs * Math.PI * 2)));
  let position = elapsedMs % (34 * config.sosUnitMs);
  for (let i = 0; i < SOS_SEGMENTS.length; i++) {
    const duration = SOS_SEGMENTS[i] * config.sosUnitMs;
    if (position < duration) return i % 2 === 0 ? config.brightness : 0;
    position -= duration;
  }
  return 0;
}
export function modeCommand(config) {
  if (config.mode === 'blink') return `BLINK ${config.onMs} ${config.offMs}`;
  if (config.mode === 'breathe') return `BREATHE ${config.breatheMs}`;
  if (config.mode === 'sos') return `SOS ${config.sosUnitMs}`;
  return config.mode.toUpperCase();
}
export function describe(config) {
  if (config.mode === 'blink') return `${config.onMs} / ${config.offMs} ms`;
  if (config.mode === 'breathe') return `${(config.breatheMs / 1000).toFixed(1)} s / 周期`;
  if (config.mode === 'sos') return `··· −−− ··· / ${config.sosUnitMs} ms`;
  return config.mode === 'on' ? '持续点亮' : '关闭输出';
}
