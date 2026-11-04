#!/usr/bin/env node
// Development entry point: `npm start` runs the server and opens the browser.
// The desktop app (electron/main.mjs) embeds the same server.
import { spawn } from 'node:child_process';
import { startServer } from './app.mjs';

const port = Number(process.env.PORT || 7373);
try {
  const { url } = await startServer({ port });
  console.log(`\n  souldew läuft auf ${url}\n  (Strg+C beendet den Server)\n`);
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try {
      spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // no browser opener
    }
  }
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.log(`Port ${port} ist belegt – läuft souldew schon? Öffne http://localhost:${port}`);
    process.exit(1);
  }
  throw e;
}
