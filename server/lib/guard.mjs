// Request gate for the local API. The server only listens on 127.0.0.1, but every website the user opens can
// still send requests to it (fetch no-cors, <img>, <form>). These checks make sure only the app's own pages
// – the main window, the EmulatorJS iframe and the OBS overlay, all served from this origin – reach the API.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** The app's own origins for a given port: http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port>. */
export const appOrigins = (port) => LOCAL_HOSTS.map((h) => `http://${h}:${port}`);

/** Host header must name this computer (blocks DNS rebinding). */
export function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d*$/, '');
  return LOCAL_HOSTS.includes(host);
}

/**
 * Returns null when the request may reach the API, otherwise a short reason (→ 403).
 * - An `Origin` header, when present, must be one of the app's own origins ("null" is rejected too).
 * - `Sec-Fetch-Site` (sent by every current browser and Electron) must be same-origin or none (typed URL /
 *   bookmark / OBS). cross-site and same-site (another port on localhost) are rejected for every API request,
 *   which also covers GET routes with side effects (patching, downloads) that an <img> could trigger.
 * - State-changing methods additionally need the `x-soullink: 1` header (a custom header forces a CORS
 *   preflight, which this server never answers).
 */
export function apiRequestError(req, port) {
  const h = req.headers || {};
  const origin = h.origin;
  if (origin !== undefined && !appOrigins(port).includes(String(origin).toLowerCase())) return 'Cross-origin request';
  const site = h['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'Cross-site request';
  const safe = req.method === 'GET' || req.method === 'HEAD';
  if (!safe && h['x-soullink'] !== '1') return 'Missing app header';
  return null;
}
