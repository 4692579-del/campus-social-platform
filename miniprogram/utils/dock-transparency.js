const STORAGE_KEY = 'dockTransparency';
const MIN_TRANSPARENCY = 20;
const MAX_TRANSPARENCY = 80;
const DEFAULT_TRANSPARENCY = (MIN_TRANSPARENCY + MAX_TRANSPARENCY) / 2;
// Preserve the material already assigned to each transparency value.
const OPTICS_REFERENCE_TRANSPARENCY = 53;
const listeners = new Set();

function normalizeTransparency(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : DEFAULT_TRANSPARENCY;
}

function clampTransparency(value) {
  return Math.min(MAX_TRANSPARENCY, Math.max(MIN_TRANSPARENCY, normalizeTransparency(value)));
}

function glassStyle(transparency) {
  const value = normalizeTransparency(transparency);
  const fill = 1 - value / 100;
  const clearProgress = Math.max(0, (value - OPTICS_REFERENCE_TRANSPARENCY) / (100 - OPTICS_REFERENCE_TRANSPARENCY));
  const fallback = value <= OPTICS_REFERENCE_TRANSPARENCY
    ? 1 - 0.1 * value / OPTICS_REFERENCE_TRANSPARENCY
    : 0.9 * (1 - clearProgress);
  const strength = 1 - clearProgress;
  const blur = (1.5 * (100 - value) / (100 - OPTICS_REFERENCE_TRANSPARENCY)).toFixed(3);
  const contrast = (1 + 0.02 * strength).toFixed(4);
  const surfaceSaturation = (100 + 40 * strength).toFixed(2);
  const lensSaturation = (100 + 45 * strength).toFixed(2);
  return [
    `--dock-glass-fill:${fill.toFixed(3)};`,
    `--dock-glass-fallback:${fallback.toFixed(3)};`,
    `--dock-glass-strength:${strength.toFixed(3)};`,
    `--dock-surface-filter:blur(${blur}px) saturate(${surfaceSaturation}%) contrast(${contrast});`,
    `--dock-lens-filter:blur(${blur}px) saturate(${lensSaturation}%) contrast(${contrast});`,
    `--dock-optics-display:${value === 100 ? 'none' : 'block'};`,
  ].join(' ');
}

function readTransparency(api) {
  try { return clampTransparency(api.getStorageSync(STORAGE_KEY)); }
  catch (error) { return DEFAULT_TRANSPARENCY; }
}

function saveTransparency(api, value) {
  const transparency = clampTransparency(value);
  api.setStorageSync(STORAGE_KEY, transparency);
  for (const listener of listeners) listener(transparency);
}

function observeTransparency(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

module.exports = {
  DEFAULT_TRANSPARENCY, MIN_TRANSPARENCY, MAX_TRANSPARENCY,
  clampTransparency, glassStyle, readTransparency, saveTransparency, observeTransparency,
};
