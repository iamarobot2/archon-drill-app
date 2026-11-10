// drill-app: a tiny web service with fault switches an operator can flip from outside, without redeploying.
// It exists to rehearse failure handling (monitoring, auto-restart, rollback). Never run it as a real product.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const KINDS = ['health-fail', 'error-rate', 'latency', 'leak', 'crash-loop', 'crash-on-start'];
const MAX = { ttlMs: 30 * 60_000, delayMs: 60_000, leakMb: 4096 };
const sha = (v) => createHash('sha256').update(String(v)).digest();

export function authorized(env, given) {
  if (typeof given !== 'string' || !given) return false;
  const want = env.ADMIN_TOKEN ? sha(env.ADMIN_TOKEN) : /^[0-9a-f]{64}$/i.test(env.ADMIN_TOKEN_SHA256 ?? '') ? Buffer.from(env.ADMIN_TOKEN_SHA256, 'hex') : null;
  return want !== null && timingSafeEqual(sha(given), want);
}

const pos = (v, max) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : null);

export function validate(f) {
  if (!f || typeof f !== 'object' || !KINDS.includes(f.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (f.kind === 'error-rate' && !(f.fraction > 0 && f.fraction <= 1)) return 'fraction must be in (0, 1]';
  if (f.kind === 'latency' && !pos(f.delayMs, MAX.delayMs)) return 'delayMs must be a positive integer';
  if (f.kind === 'leak' && !pos(f.mbPerSec, 1024)) return 'mbPerSec must be a positive integer';
  return null;
}

// Release identity is baked into the image (version.json). A release marked broken fails its health check: the "bad release" fault.
export function release(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'version.json'), 'utf8')); } catch { return { version: process.env.APP_VERSION ?? 'dev', broken: false }; }
}

export function createApp({ env = process.env, exit = process.exit, dataDir = env.DATA_DIR || tmpdir(), appDir = dirname() } = {}) {
  const marker = join(dataDir, 'drill-app.poison');
  const rel = release(appDir);
  const faults = new Map();
  let seq = 0, acc = 0, leak = [];

  // A poison marker on the data dir survives a container restart (a crash loop) but not a replaced pod: a restart of the pod cures it.
  if (existsSync(marker)) {
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8'));
      if (m.until > Date.now()) {
        if (m.times !== undefined) { m.times -= 1; if (m.times <= 0) rmSync(marker, { force: true }); else writeFileSync(marker, JSON.stringify(m)); }
        exit(1);
      } else rmSync(marker, { force: true });
    } catch { rmSync(marker, { force: true }); }
  }

  const stop = (id) => { const x = faults.get(id); if (!x) return; clearTimeout(x.timer); clearInterval(x.tick); faults.delete(id); if (x.fault.kind === 'leak') leak = []; };
  const stopAll = () => { for (const id of [...faults.keys()]) stop(id); rmSync(marker, { force: true }); };
  const on = (kind) => [...faults.values()].find((x) => x.fault.kind === kind)?.fault;

  function add(f) {
    const ttl = pos(f.ttlMs, MAX.ttlMs) ?? MAX.ttlMs; // every fault expires: nothing is unbounded
    const id = `f${++seq}`;
    const x = { fault: f, expiresAt: Date.now() + ttl };
    x.timer = setTimeout(() => stop(id), ttl); x.timer.unref?.();
    if (f.kind === 'leak') {
      const cap = pos(f.limitMb, MAX.leakMb) ?? MAX.leakMb;
      x.tick = setInterval(() => { if (leak.length * f.mbPerSec < cap) leak.push(Buffer.alloc(f.mbPerSec * 1048576, 1)); }, 1000); // allocates and touches pages, so it counts as resident
      x.tick.unref?.();
    }
    faults.set(id, x);
    return id;
  }

  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readJson = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(undefined); } }); });
  const state = () => ({ version: rel.version, broken: rel.broken, active: faults.size > 0, faults: [...faults].map(([id, x]) => ({ id, ...x.fault, expiresAt: x.expiresAt })) });

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (path === '/fault') {
        if (!authorized(env, req.headers['x-drill-token'])) return send(res, 403, { error: 'forbidden' });
        if (req.method === 'GET') return send(res, 200, state());
        if (req.method === 'DELETE') { stopAll(); return send(res, 200, state()); }
        if (req.method !== 'POST') return send(res, 405, { error: 'method' });
        const f = await readJson(req);
        const bad = validate(f);
        if (bad) return send(res, 400, { error: bad });
        if (f.kind === 'crash-loop' || f.kind === 'crash-on-start') {
          writeFileSync(marker, JSON.stringify({ until: Date.now() + (pos(f.ttlMs, MAX.ttlMs) ?? MAX.ttlMs), ...(f.kind === 'crash-on-start' ? { times: 1 } : {}) }));
          send(res, 202, { exiting: true });
          setTimeout(() => exit(1), 10);
          return undefined;
        }
        return send(res, 200, { id: add(f), ...state() });
      }
      if (path === '/health') {
        if (rel.broken || on('health-fail')) return send(res, 500, { ok: false, version: rel.version });
        return send(res, 200, { ok: true, version: rel.version });
      }
      if (path === '/' || path === '/work') {
        const l = on('latency');
        if (l) await new Promise((r) => setTimeout(r, l.delayMs));
        const e = on('error-rate');
        if (e) { acc += e.fraction; if (acc >= 1 - 1e-9) { acc -= 1; return send(res, 500, { error: 'injected' }); } }
        return send(res, 200, { ok: true, version: rel.version });
      }
      return send(res, 404, { error: 'not found' });
    } catch { return send(res, 500, { error: 'internal' }); }
  });
  return { server, stopAll, state, listen: (port) => new Promise((r) => server.listen(port, () => r(server.address().port))), close: () => { stopAll(); server.closeAllConnections?.(); server.close(); } };
}

function dirname() { return fileURLToPath(new URL('.', import.meta.url)); }

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  createApp().listen(Number(process.env.PORT) || 8080).then((p) => console.log(`drill-app ${release(dirname()).version} listening on ${p}`));
}
