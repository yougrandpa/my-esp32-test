import { DEFAULTS, validConfig } from './effects.mjs';

export const FAVORITES_KEY = 'esp32-led-favorites-v1';
export const MAX_FAVORITES = 20;

export function readFavorites(storage) {
  const raw = storage.getItem(FAVORITES_KEY);
  if (!raw) return [];
  const data = JSON.parse(raw);
  if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > MAX_FAVORITES) {
    throw new Error('收藏数据格式无效');
  }
  const ids = new Set();
  return data.items.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || item.name.trim().length > 24 || !validConfig(item.config)) {
      throw new Error('收藏数据格式无效');
    }
    ids.add(item.id);
    const config = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, item.config[key]]));
    return { id: item.id, name: item.name.trim(), config };
  });
}

export function writeFavorites(storage, items) {
  storage.setItem(FAVORITES_KEY, JSON.stringify({ version: 1, items }));
}
