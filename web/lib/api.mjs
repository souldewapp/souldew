// Thin fetch wrapper for the local server. The x-soullink header is the server's CSRF guard.
import { serverErrorText } from './errors.mjs';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'x-soullink': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(serverErrorText(data && typeof data === 'object' ? data : {}, res.status));
    err.code = data?.code;
    err.details = data?.details;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  del: (url) => request('DELETE', url),
};

/** Server-sent events with auto-reconnect (EventSource does that natively). */
export function events(handlers) {
  const es = new EventSource('/api/events');
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error('event handler failed', name, err);
      }
    });
  }
  return () => es.close();
}
