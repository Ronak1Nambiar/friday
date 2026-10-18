// Local HUD server: serves the page, pushes state over Server-Sent Events, and
// accepts commands back from the page. Binds to 127.0.0.1 only.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { which } from './agents.js';

const HUD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hud');

// `assets`: the folder theme images are served from (/theme-asset/<name>).
// `onTheme({ data, ext, request })`: an image (and/or words) uploaded from the web HUD.
export function createHud({ port = 7777, onCommand, onTheme, assets = null, theme = null } = {}) {
  const clients = new Set();
  const state = { agents: [], project: null, projects: [], feed: [], mode: 'edit', active: null, cwd: '', theme };

  const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const publish = (type, data) => { for (const c of clients) send(c, type, data); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      clients.add(res);
      send(res, 'state', state);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state));
    }
    // Same-origin check: only the HUD page itself may drive the cockpit.
    const foreign = () => {
      const origin = req.headers.origin;
      return origin && origin !== `http://127.0.0.1:${hud.port}` && origin !== `http://localhost:${hud.port}`;
    };
    if (url.pathname === '/api/command' && req.method === 'POST') {
      if (foreign()) { res.writeHead(403); return res.end(); }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1e5) req.destroy(); });
      req.on('end', () => {
        try { onCommand?.(JSON.parse(body).command); res.writeHead(204); } catch { res.writeHead(400); }
        res.end();
      });
      return;
    }
    // A theme from the web HUD: { image: dataURL | null, request: text }, up to ~12 MB.
    if (url.pathname === '/api/theme' && req.method === 'POST') {
      if (foreign() || !onTheme) { res.writeHead(403); return res.end(); }
      const chunks = [];
      let size = 0;
      req.on('data', (d) => { size += d.length; if (size > 16e6) { res.writeHead(413); res.end(); req.destroy(); } else chunks.push(d); });
      req.on('end', () => {
        try {
          const { image, request } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const m = typeof image === 'string' ? /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
          if (image && !m) throw new Error('not an image');
          if (!m && !String(request || '').trim()) throw new Error('nothing to do');
          onTheme({ data: m ? Buffer.from(m[2], 'base64') : null, ext: m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : null, request: String(request || '').slice(0, 2000) });
          res.writeHead(202);
        } catch { res.writeHead(400); }
        res.end();
      });
      return;
    }
    const asset = /^\/theme-asset\/([\w.-]+\.(png|jpe?g|gif|webp))$/i.exec(url.pathname);
    if (asset && assets) {
      const f = path.join(assets, asset[1]);
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': `image/${asset[2].toLowerCase() === 'jpg' ? 'jpeg' : asset[2].toLowerCase()}`, 'cache-control': 'max-age=31536000' });
      return fs.createReadStream(f).pipe(res);
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(HUD_DIR, file);
    if (!full.startsWith(HUD_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(full)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    fs.createReadStream(full).pipe(res);
  });

  // Heartbeat keeps proxies and the EventSource happy.
  const beat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 15000);
  beat.unref();

  const hud = {
    state,
    port: 0,
    get url() { return `http://127.0.0.1:${hud.port}/`; },
    get viewers() { return clients.size; },
    listen() {
      return new Promise((resolve) => {
        const tryPort = (p) => {
          server.once('error', (e) => { if (e.code === 'EADDRINUSE' && p !== 0) tryPort(0); else throw e; });
          server.listen(p, '127.0.0.1', () => { hud.port = server.address().port; resolve(hud); });
        };
        tryPort(port);
      });
    },
    set(patch) { Object.assign(state, patch); publish('patch', patch); },
    feed(item) {
      const entry = { t: Date.now(), ...item };
      state.feed.push(entry);
      if (state.feed.length > 80) state.feed.shift();
      publish('feed', entry);
    },
    publish,
    close() { clearInterval(beat); for (const c of clients) c.end(); server.close(); },
  };
  return hud;
}

// Open the HUD as a frameless app window where we can, a browser tab otherwise.
export function openWindow(url, browser) {
  const tries = [];
  if (browser) tries.push([browser, [`--app=${url}`]]);
  if (process.platform === 'linux') {
    tries.push(['omarchy-launch-webapp', [url]]);
    for (const b of ['chromium', 'google-chrome', 'brave', 'microsoft-edge']) tries.push([b, [`--app=${url}`, '--new-window']]);
    tries.push(['xdg-open', [url]]);
  } else if (process.platform === 'darwin') {
    tries.push(['open', ['-na', 'Google Chrome', '--args', `--app=${url}`]], ['open', [url]]);
  } else if (process.platform === 'win32') {
    // Built by hand: Node would turn the empty title "" into "\"\"" (see openTerminal).
    tries.push(['cmd', ['/d', '/s', '/c', `"start "" msedge --app=${url}"`], { windowsVerbatimArguments: true }]);
  }
  for (const [cmd, args, opts = {}] of tries) {
    if (process.platform !== 'win32' && cmd !== 'open' && !which(cmd)) continue;
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore', ...opts }).on('error', () => {}).unref();
      return cmd;
    } catch {}
  }
  return null;
}
