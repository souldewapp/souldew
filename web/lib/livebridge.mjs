// What the mGBA live bridge is doing, for the "Playing with mGBA" panel. `live` is the server's LiveBridge.status().

/** A rejected script counts as the reason for "no connection" only for this long (it retries every few seconds). */
export const REJECTED_FRESH = 2 * 60 * 1000;

/**
 * One of: 'live' (data is coming in), 'noPort' (the bridge couldn't start), 'unsupported' (connected, but no live
 * data for that game), 'connected' (script connected, no game data yet), 'rejected' (a script from another install
 * or an outdated one tried to connect), 'waiting' (no script connected). `outdated`: the connected script is older
 * than the one souldew writes now.
 */
export function bridgeState(live, { fresh = false, now = Date.now() } = {}) {
  const conn = live?.connection || null;
  const outdated = !!(conn && live?.scriptVersion && (conn.version || 1) < live.scriptVersion);
  let key;
  if (fresh) key = 'live';
  else if (live?.error && !live?.port) key = 'noPort';
  else if (conn && !conn.supported) key = 'unsupported';
  else if (conn) key = 'connected';
  else if (live?.rejected?.at && now - live.rejected.at < REJECTED_FRESH) key = 'rejected';
  else key = 'waiting';
  return { key, outdated, game: conn?.game || null };
}
