// User randomizer presets ("My presets" in New Run), stored in config.json under `randomizerPresets`.
// Pure list operations – server/app.mjs loads and saves the config around them.
import { randomBytes } from 'node:crypto';
import { sanitizeValues } from '../../shared/randomizer-options.mjs';
import { httpError } from './fsutil.mjs';

export const MAX_PRESETS = 50;
const NAME_MAX = 40;

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);

/** Saved presets from the config, dropping anything malformed (a hand-edited config must not break New Run). */
export function listPresets(config) {
  const list = Array.isArray(config?.randomizerPresets) ? config.randomizerPresets : [];
  return list
    .filter((p) => p && typeof p === 'object' && /^u-[a-f0-9]{8}$/.test(p.id) && cleanName(p.name))
    .map((p) => ({ id: p.id, name: cleanName(p.name), values: sanitizeValues(p.values), createdAt: p.createdAt || null, updatedAt: p.updatedAt || null }));
}

/**
 * Create (no id) or update (id: rename and/or new values) a preset. Returns { preset, presets }.
 * A new preset needs values; on update, values are optional (= rename only).
 */
export function savePreset(list, { id, name, values } = {}, now = new Date().toISOString()) {
  const n = cleanName(name);
  if (!n) throw httpError(400, 'Name für das Preset fehlt', 'presetName');
  const presets = [...list];
  if (id) {
    const i = presets.findIndex((p) => p.id === id);
    if (i < 0) throw httpError(404, 'Preset nicht gefunden', 'presetNotFound');
    const preset = { ...presets[i], name: n, values: values ? sanitizeValues(values) : presets[i].values, updatedAt: now };
    presets[i] = preset;
    return { preset, presets };
  }
  if (!values || typeof values !== 'object') throw httpError(400, 'Einstellungen für das Preset fehlen', 'presetValues');
  if (presets.length >= MAX_PRESETS) throw httpError(400, `Höchstens ${MAX_PRESETS} Presets möglich`, 'presetLimit', { max: MAX_PRESETS });
  let newId;
  do newId = `u-${randomBytes(4).toString('hex')}`; while (presets.some((p) => p.id === newId));
  const preset = { id: newId, name: n, values: sanitizeValues(values), createdAt: now, updatedAt: now };
  presets.push(preset);
  return { preset, presets };
}

export function deletePreset(list, id) {
  if (!list.some((p) => p.id === id)) throw httpError(404, 'Preset nicht gefunden', 'presetNotFound');
  return list.filter((p) => p.id !== id);
}
