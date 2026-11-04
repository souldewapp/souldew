// One-click "Start over": build a new run from an old one (same settings, rules, mode and players, new seeds).
import { api } from './api.mjs';
import { gameById, hackById, gameTitle } from './data.mjs';
import { restartRequest } from '/shared/restart.mjs';
import { slotsOf } from '/shared/slots.mjs';

/**
 * Which player of run `m` is on this computer (what the app stored via setMe) – only a slot the run has. Without
 * a stored choice: the host is p1, an imported invite the first player after them.
 */
export function mySlotIn(m) {
  const slots = slotsOf(m);
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem(`sl-me-${m.id}`) ?? 'null');
    if (slots.includes(s)) return s;
  } catch { /* private mode, garbage */ }
  return m.imported && slots.length > 1 ? 'p2' : 'p1';
}

/**
 * Restart `oldManifest` (full manifest or just { id }) as a new run and build its games.
 * opts.rules: the old run's live doc rules (else they are read from its saved doc / manifest).
 * Resolves to { manifest, pack, mySlot, log }: the new full manifest, its invite pack
 * (what the other players import) and the slot this computer plays – the others keep theirs.
 * The caller should setRunId / setMe(mySlot, manifest.id) / reloadStatus afterwards.
 */
export async function restartRun(oldManifest, opts = {}) {
  const old = await api.get(`/api/runs/${oldManifest.id}`);
  const [library, status, doc] = await Promise.all([
    api.get('/api/library'),
    opts.runs ? null : api.get('/api/status').catch(() => null),
    opts.rules !== undefined ? null : api.get(`/api/runs/${old.id}/doc`).catch(() => null),
  ]);
  const mySlot = mySlotIn(old);
  const hack = old.game?.hackId ? hackById(old.game.hackId) : null;
  const game = old.game?.id ? gameById(old.game.id) : null;
  const body = restartRequest(old, {
    library,
    runs: opts.runs || status?.runs || [],
    // doc entries are { v, t, by }; a rules change from the partner may not be in the manifest yet
    rules: opts.rules !== undefined ? opts.rules : doc?.rules?.v ?? undefined,
    mySlot,
    gameTitle: hack?.name || (game ? gameTitle(game) : null),
  });
  const res = await api.post('/api/runs/build', body);
  // The Discord webhook is local (not part of the rules): carry this computer's over to the new run.
  try {
    const { webhook } = await api.get(`/api/runs/${old.id}/discord`);
    if (webhook) await api.put(`/api/runs/${res.manifest.id}/discord`, { webhook });
  } catch {
    // no webhook / old run gone – nothing to carry over
  }
  const manifest = await api.get(`/api/runs/${res.manifest.id}`);
  return { manifest, pack: manifest.pack, mySlot, log: res.log };
}
