// Route-level tests of the public plugin update routes: fake GitHub releases, the app on an
// ephemeral port. The cache is module state, so the tests run in order and build on each other.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';

// config.js exits on missing env: set it before importing.
const TOKEN = 'ghp_geheim_testtoken';
const home = mkdtempSync(join(tmpdir(), 'plugin-update-test-'));
mkdirSync(join(home, '.ssh'));
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: TOKEN, BRICKS_LICENSE_KEY: 'e',
});
const { pool, initDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const db = new PGlite();
let queries = 0;
// Parameterless calls may hold several statements (initDb); PGlite runs those with exec.
const query = async (sql, params) => {
  queries++;
  return params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) };
};
pool.query = query;
pool.connect = async () => ({ query, release() {} });

const API = 'https://api.github.com/repos/woutr-nl/WOUTR-WP';
const zipOf = (tag) => Buffer.from(`zip van ${tag}`);
const release = (tag, { asset = 'woutr-plugin.zip', size = 1000, ...flags } = {}) => ({
  tag_name: tag, draft: false, prerelease: false, ...flags,
  assets: [{ name: asset, size, url: `${API}/releases/assets/${tag}`, browser_download_url: `https://github.invalid/${tag}` }],
});
const PHP = '<?php\n/**\n * Plugin Name: WOUTR\n * Tested up to: 6.8\n * Requires at least: 6.5\n * requires php: 8.0\n */\n';

// Fake GitHub: releases, their assets and the plugin main file per tag, plus a request log.
const github = {
  fail: false, assetFail: false, calls: [],
  releases: [
    release('woutr-plugin-v1.0.0'), // newest by date, lower version
    release('woutr-plugin-v9.0.0', { draft: true }),
    release('woutr-plugin-v8.0.0', { prerelease: true }),
    release('woutr-plugin-v6.0.0-rc1'),
    release('woutr-plugin-v9'), // one segment: the plugin rejects that version
    release('x-v9.9.9'),
    release('woutr-v9.9.9'),
    release('woutr-plugin-v7.0.0', { asset: 'iets-anders.zip' }),
    release('woutr-plugin-v1.9.0'),
    release('woutr-plugin-v1.10.0'), // numeric, not string, comparison
  ],
  php: { 'woutr-plugin-v1.10.0': PHP, 'woutr-plugin-v2.0.0': '<?php // geen headers\n', 'woutr-plugin-v2.2.0': PHP },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.github.com') return realFetch(url, opts);
  github.calls.push({ url: String(url), accept: opts.headers.Accept, authorization: opts.headers.Authorization });
  if (github.fail) return new Response(`{"message":"fout voor ${opts.headers.Authorization}"}`, { status: 500 });
  if (u.pathname === '/repos/woutr-nl/WOUTR-WP/releases') return Response.json(github.releases);
  const asset = u.pathname.match(/\/releases\/assets\/(.+)$/);
  if (asset) return github.assetFail ? new Response('{}', { status: 500 }) : new Response(zipOf(asset[1]));
  if (u.pathname === '/repos/woutr-nl/WOUTR-WP/contents/plugin/woutr-plugin.php') {
    const php = github.php[u.searchParams.get('ref')];
    return php == null ? new Response('{}', { status: 404 }) : new Response(php);
  }
  return new Response('{}', { status: 404 });
};

let app, base;
const get = (path, headers = {}) => realFetch(base + path, { redirect: 'manual', headers });
const info = async () => (await get('/woutr-plugin/update.json')).json();
const zip = async () => Buffer.from(await (await get('/woutr-plugin/woutr-plugin.zip')).arrayBuffer());
const etagOf = (tag) => `"${createHash('sha256').update(zipOf(tag)).digest('base64url')}"`;
// node:http, as fetch adds Cache-Control: no-cache to a conditional request.
const conditionalZip = (etag) => new Promise((resolve, reject) => {
  httpGet(`${base}/woutr-plugin/woutr-plugin.zip`, { headers: { 'If-None-Match': etag } }, (r) => resolve(r.resume().statusCode)).on('error', reject);
});
const crossTtl = () => mock.timers.tick(5 * 60_000 + 1);
const crossBackoff = () => mock.timers.tick(60_000 + 1);
const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail('voorwaarde werd niet op tijd waar');
};
// Crossing the TTL still answers from the cache and refreshes behind it.
const expectRefreshTo = async (version) => {
  crossTtl();
  const old = (await info()).version;
  assert.notEqual(old, version);
  await until(async () => (await info()).version === version);
};
// Crossing the TTL, the refresh attempt fails: settle it, the old version stays.
const expectRefreshFailureKeeps = async (version) => {
  crossTtl();
  const seen = github.calls.length;
  assert.equal((await info()).version, version);
  await until(() => github.calls.length > seen);
  await sleep(20);
  assert.equal((await info()).version, version);
};

before(async () => {
  await initDb();
  queries = 0;
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => {
  mock.timers.reset();
  app.close();
});

test('without a cache and with GitHub down both routes answer 503, without the token', async () => {
  github.fail = true;
  const res = await get('/woutr-plugin/update.json');
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.ok(JSON.parse(body).error);
  assert.ok(!body.includes(TOKEN) && !body.includes('Bearer'));
  const zipRes = await get('/woutr-plugin/woutr-plugin.zip');
  assert.equal(zipRes.status, 503);
  const zipBody = await zipRes.text();
  assert.ok(!zipBody.includes(TOKEN) && !zipBody.includes('Bearer'));
});

test('without a cache a failing GitHub is asked once per back-off window', async () => {
  crossBackoff();
  let seen = github.calls.length;
  for (let i = 0; i < 5; i++) {
    assert.equal((await get('/woutr-plugin/update.json')).status, 503);
    assert.equal((await get('/woutr-plugin/woutr-plugin.zip')).status, 503);
  }
  assert.equal(github.calls.length, seen + 1);
  crossBackoff();
  seen = github.calls.length;
  assert.equal((await get('/woutr-plugin/update.json')).status, 503);
  assert.equal(github.calls.length, seen + 1);
  github.fail = false;
  crossBackoff();
});

test('update.json is public and names the highest real plugin release', async () => {
  const res = await get('/woutr-plugin/update.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(await res.json(), {
    slug: 'woutr-plugin',
    version: '1.10.0',
    package: `${base}/woutr-plugin/woutr-plugin.zip`,
    tested: '6.8',
    requires: '6.5',
    requires_php: '8.0',
  });
  assert.ok(github.calls.some((c) => c.url === `${API}/contents/plugin/woutr-plugin.php?ref=woutr-plugin-v1.10.0`));
});

test('the package address follows the proxy scheme', async () => {
  const res = await get('/woutr-plugin/update.json', { 'X-Forwarded-Proto': 'https' });
  assert.equal((await res.json()).package, `${base.replace('http:', 'https:')}/woutr-plugin/woutr-plugin.zip`);
});

test('the zip is public and comes from the API asset URL', async () => {
  const res = await get('/woutr-plugin/woutr-plugin.zip');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), zipOf('woutr-plugin-v1.10.0'));
  const download = github.calls.find((c) => c.url === `${API}/releases/assets/woutr-plugin-v1.10.0`);
  assert.equal(download.accept, 'application/octet-stream');
  assert.equal(download.authorization, `Bearer ${TOKEN}`);
});

test('the zip carries the ETag hashed once for its version, and a match gets 304', async () => {
  const res = await get('/woutr-plugin/woutr-plugin.zip');
  assert.equal(res.headers.get('etag'), etagOf('woutr-plugin-v1.10.0'));
  assert.equal(await conditionalZip(etagOf('woutr-plugin-v1.10.0')), 304);
});

test('within the TTL GitHub is not asked again', async () => {
  const seen = github.calls.length;
  await info();
  await zip();
  assert.equal(github.calls.length, seen);
});

test('a TTL check of an unchanged release downloads nothing', async () => {
  crossTtl();
  const seen = github.calls.length;
  await info();
  await until(() => github.calls.length > seen);
  await sleep(20);
  assert.deepEqual(github.calls.slice(seen).map((c) => c.url), [`${API}/releases?per_page=100`]);
  const refreshed = github.calls.length;
  await info();
  assert.equal(github.calls.length, refreshed);
});

test('headers absent from the plugin file are left out', async () => {
  github.releases.push(release('woutr-plugin-v2.0.0'));
  await expectRefreshTo('2.0.0');
  assert.deepEqual(Object.keys(await info()).sort(), ['package', 'slug', 'version']);
  // The new release brings a new ETag: the old one must not turn the update into a 304.
  const etag = (await get('/woutr-plugin/woutr-plugin.zip')).headers.get('etag');
  assert.equal(etag, etagOf('woutr-plugin-v2.0.0'));
  assert.notEqual(etag, etagOf('woutr-plugin-v1.10.0'));
  assert.equal(await conditionalZip(etagOf('woutr-plugin-v1.10.0')), 200);
  assert.equal(await conditionalZip(etag), 304);
});

test('a missing plugin file does not stop the update', async () => {
  github.releases.push(release('woutr-plugin-v2.1.0'));
  await expectRefreshTo('2.1.0');
  assert.deepEqual(Object.keys(await info()).sort(), ['package', 'slug', 'version']);
});

test('a new release is served without a restart', async () => {
  github.releases.push(release('woutr-plugin-v2.2.0'));
  await expectRefreshTo('2.2.0');
  assert.deepEqual(await zip(), zipOf('woutr-plugin-v2.2.0'));
  assert.equal((await info()).tested, '6.8');
});

test('with GitHub failing the last known version keeps being served, without the token', async () => {
  github.fail = true;
  await expectRefreshFailureKeeps('2.2.0');
  const res = await get('/woutr-plugin/update.json');
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes(TOKEN) && !body.includes('Bearer'));
  const bytes = await zip();
  assert.deepEqual(bytes, zipOf('woutr-plugin-v2.2.0'));
  assert.ok(!bytes.includes(TOKEN));

  // The failed refresh above started the back-off: one GitHub call per window here too.
  const seen = github.calls.length;
  for (let i = 0; i < 5; i++) assert.equal((await info()).version, '2.2.0');
  await zip();
  await sleep(20);
  assert.equal(github.calls.length, seen);
  crossBackoff();
  for (let i = 0; i < 5; i++) assert.equal((await info()).version, '2.2.0');
  await sleep(20);
  assert.equal(github.calls.length, seen + 1);
  github.fail = false;
});

test('a failed or refused download keeps the last known version', async () => {
  github.releases.push(release('woutr-plugin-v3.0.0'));
  github.assetFail = true;
  await expectRefreshFailureKeeps('2.2.0');
  github.assetFail = false;
  github.releases.pop();

  github.releases.push(release('woutr-plugin-v3.1.0', { size: 50 * 1024 * 1024 + 1 }));
  await expectRefreshFailureKeeps('2.2.0');
  assert.ok(!github.calls.some((c) => c.url.endsWith('/releases/assets/woutr-plugin-v3.1.0')));
  assert.deepEqual(await zip(), zipOf('woutr-plugin-v2.2.0'));
  github.releases.pop();
});

test('everything else stays behind the login, and the routes touch no database', async () => {
  for (const path of ['/', '/instellingen', '/woutr-plugin/anything-else', '/woutr-plugin/x-v9.9.9.zip', '/woutr-plugin/']) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get('location'), '/login', path);
  }
  assert.equal(queries, 0);
});

test('HEAD works on both routes', async () => {
  for (const path of ['/woutr-plugin/update.json', '/woutr-plugin/woutr-plugin.zip']) {
    assert.equal((await realFetch(base + path, { method: 'HEAD' })).status, 200, path);
  }
});
