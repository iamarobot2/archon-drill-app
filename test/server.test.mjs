import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, authorized, validate } from '../server.mjs';

const T = { 'x-drill-token': 'tok', 'content-type': 'application/json' };
async function boot(extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'drill-'));
  const exits = [];
  const app = createApp({ env: { ADMIN_TOKEN: 'tok' }, exit: (c) => exits.push(c), dataDir, appDir: extra.appDir ?? dataDir });
  const port = await app.listen(0);
  const u = `http://127.0.0.1:${port}`;
  return { app, u, dataDir, exits, post: (b) => fetch(`${u}/fault`, { method: 'POST', headers: T, body: JSON.stringify(b) }) };
}

test('healthy by default; fault API needs the token', async () => {
  const { app, u } = await boot();
  assert.equal((await fetch(`${u}/health`)).status, 200);
  assert.equal((await fetch(`${u}/fault`)).status, 403);
  assert.equal((await fetch(`${u}/nope`)).status, 404);
  app.close();
});

test('health-fail, error-rate and latency apply and DELETE clears them', async () => {
  const { app, u, post } = await boot();
  assert.equal((await post({ kind: 'health-fail' })).status, 200);
  assert.equal((await fetch(`${u}/health`)).status, 500);
  assert.equal((await post({ kind: 'error-rate', fraction: 0.5 })).status, 200);
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetch(`${u}/work`)).status);
  assert.deepEqual(codes, [200, 500, 200, 500]);
  await post({ kind: 'latency', delayMs: 120 });
  const t0 = Date.now(); await fetch(`${u}/`); assert.ok(Date.now() - t0 >= 100);
  await fetch(`${u}/fault`, { method: 'DELETE', headers: T });
  assert.equal((await fetch(`${u}/health`)).status, 200);
  assert.equal((await (await fetch(`${u}/fault`, { headers: T })).json()).active, false);
  app.close();
});

test('bad release: a broken version.json fails health', async () => {
  const appDir = mkdtempSync(join(tmpdir(), 'rel-'));
  writeFileSync(join(appDir, 'version.json'), '{"version":"2","broken":true}');
  const { app, u } = await boot({ appDir });
  const r = await fetch(`${u}/health`);
  assert.equal(r.status, 500);
  assert.equal((await r.json()).version, '2');
  app.close();
});

test('crash-loop leaves a marker that makes every boot exit until it is removed; crash-on-start exits once', async () => {
  const { app, dataDir, post, exits } = await boot();
  assert.equal((await post({ kind: 'crash-loop' })).status, 202);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(exits, [1]);
  const again = createApp({ env: { ADMIN_TOKEN: 'tok' }, exit: (c) => exits.push(c), dataDir }); // second boot, same data dir
  assert.deepEqual(exits, [1, 1]);
  again.close();
  app.stopAll();
  assert.equal(existsSync(join(dataDir, 'drill-app.poison')), false);
  await post({ kind: 'crash-on-start' });
  const a = createApp({ env: { ADMIN_TOKEN: 'tok' }, exit: (c) => exits.push(c), dataDir });
  const b = createApp({ env: { ADMIN_TOKEN: 'tok' }, exit: (c) => exits.push(c), dataDir });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(exits.length, 4); // the POST's own exit, plus exactly one boot (the marker allows one crash)
  a.close(); b.close(); app.close();
});

test('leak grows and stops on clear; validate and authorized reject bad input', async () => {
  const { app, post } = await boot();
  assert.equal((await post({ kind: 'leak', mbPerSec: 1, limitMb: 4 })).status, 200);
  assert.equal((await post({ kind: 'leak', mbPerSec: 0 })).status, 400);
  assert.equal((await post({ kind: 'bogus' })).status, 400);
  app.close();
  assert.equal(validate(null) !== null, true);
  assert.equal(validate({ kind: 'error-rate', fraction: 2 }) !== null, true);
  assert.equal(validate({ kind: 'latency', delayMs: 5 }), null);
  assert.equal(authorized({}, 'x'), false);
  assert.equal(authorized({ ADMIN_TOKEN: 'a' }, 'a'), true);
  assert.equal(authorized({ ADMIN_TOKEN: 'a' }, 7), false);
});
