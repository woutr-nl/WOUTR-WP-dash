// Route-level tests of the DirectAdmin key wiring in app.js: real schema and SQL on an
// in-process Postgres (PGlite), a fake DirectAdmin panel, the app on an ephemeral port.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// config.js exits on missing env, sshkey.js writes ~/.ssh/id: set both before importing.
const home = mkdtempSync(join(tmpdir(), 'app-test-'));
mkdirSync(join(home, '.ssh'));
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: 'd', BRICKS_LICENSE_KEY: 'e',
});
const { default: config } = await import('../src/config.js');
const { pool, initDb } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');
const { initSshKey, getKeyInfo } = await import('../src/sshkey.js');
const { keyBlob } = await import('../src/directadmin.js');
const { createApp } = await import('../src/app.js');

const db = new PGlite();
// Parameterless calls may hold several statements (initDb); PGlite runs those with exec.
const query = async (sql, params) => (params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) });
pool.query = query;
pool.connect = async () => ({ query, release() {} });

// Fake DirectAdmin panel: accounts with their authorized keys, plus a request log.
let accounts, calls;
const da = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const cmd = url.pathname.slice(1);
    const params = Object.fromEntries(req.method === 'GET' ? url.searchParams : new URLSearchParams(body));
    const as = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString().split(':')[0].split('|')[1];
    calls.push({ method: req.method, cmd, params, as });
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const u = accounts[as ?? params.user];
    if (cmd === 'CMD_API_SHOW_USERS') return send({ list: Object.keys(accounts) });
    if (cmd === 'CMD_API_SHOW_USER_CONFIG') return send({ username: params.user, ssh: 'ON' });
    if (cmd === 'CMD_SSH_KEYS' && req.method === 'GET') return send({ authorized_keys: u.keys });
    if (cmd === 'CMD_SSH_KEYS' && params.action === 'authorize') {
      u.keys[`SHA256:${randomBytes(6).toString('hex')}`] = { key: params.text };
      return send({ error: '0' });
    }
    if (cmd === 'CMD_SSH_KEYS' && params.action === 'delete') {
      delete u.keys[params.select0];
      return send({ error: '0' });
    }
    send({ error: '1', text: 'unknown command' });
  });
});

let app, base, cookie;
before(async () => {
  await initDb();
  await initSshKey();
  await new Promise((r) => da.listen(0, '127.0.0.1', r));
  await db.query('INSERT INTO directadmin (url, username, password_enc) VALUES ($1, $2, $3)',
    [`http://127.0.0.1:${da.address().port}`, 'res', encrypt('s3cr3t', config.encryptionKey)]);
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
  const res = await post('/login', { username: 'admin', password: 'pw' });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
});
after(() => { app.close(); da.close(); });

beforeEach(async () => {
  calls = [];
  accounts = { klant: { keys: {} }, andere: { keys: {} } };
  await db.query('DELETE FROM sites');
});

function post(path, form = {}) {
  return fetch(base + path, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(form),
    headers: { origin: base, ...(cookie && { cookie }) },
  });
}

let n = 0;
const siteForm = (extra = {}) => ({
  client_slug: 'acme', theme_type: 'block', ssh_target: 'deploy@127.0.0.1', wp_path: '/var/www',
  site_url: `https://acme${++n}.nl`, site_title: 'Acme', admin_email: 'a@acme.nl', ...extra,
});
const sites = async () => (await db.query('SELECT id, site_url, da_username, da_key_state FROM sites ORDER BY id')).rows;
const blobs = (user) => Object.values(accounts[user].keys).map((k) => keyBlob(k.key));
const activeBlob = async () => keyBlob((await getKeyInfo()).public_key);

test('site save with da_username installs the key and records da_key_state; clearing it resets the state', async () => {
  const res = await post('/sites', siteForm({ da_username: 'klant' }));
  assert.equal(res.status, 302);
  const [site] = await sites();
  assert.equal(site.da_key_state.status, 'installed');
  assert.equal(typeof site.da_key_state.ssh_test.outcome, 'string');
  assert.deepEqual(blobs('klant'), [await activeBlob()]);

  const edit = await post(`/sites/${site.id}`, siteForm({ site_url: site.site_url, da_username: '' }));
  assert.equal(edit.status, 302);
  const [cleared] = await sites();
  assert.equal(cleared.da_username, null);
  assert.equal(cleared.da_key_state, null);
});

test('site is still saved when the key installation fails', async () => {
  const res = await post('/sites', siteForm({ da_username: 'onbekend' }));
  assert.equal(res.status, 302);
  const [site] = await sites();
  assert.equal(site.da_username, 'onbekend');
  assert.equal(site.da_key_state.status, 'failed');
  assert.match(site.da_key_state.error, /niet gevonden/);
});

test('POST /sites/:id/install-key installs the key and removes a retired one', async () => {
  await post('/sites', siteForm());
  const [plain] = await sites();
  assert.deepEqual(await (await post(`/sites/${plain.id}/install-key`)).json(),
    { ok: false, message: 'Geen hosting-account ingevuld bij deze site.' });
  assert.equal((await post('/sites/999999/install-key')).status, 404);

  // A previous dashboard key, retired, is still authorized on the account.
  const OLD = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOld woutr-wp-dash';
  await db.query(`INSERT INTO ssh_keys (public_key, fingerprint, key_type, retired_at) VALUES ($1, 'SHA256:old', 'ssh-ed25519', now())`, [OLD]);
  await db.query('UPDATE sites SET da_username = $2 WHERE id = $1', [plain.id, 'klant']);
  accounts.klant.keys['SHA256:old'] = { key: OLD };
  const body = await (await post(`/sites/${plain.id}/install-key`)).json();
  assert.equal(body.ok, true);
  assert.match(body.message, /^Sleutel geïnstalleerd, oude sleutel verwijderd\. SSH-test: /);
  assert.deepEqual(blobs('klant'), [await activeBlob()]);
  const [site] = await sites();
  assert.equal(site.da_key_state.status, 'installed');
  assert.equal(site.da_key_state.removed_old, true);
  await db.query('DELETE FROM ssh_keys WHERE fingerprint = $1', ['SHA256:old']);
});

test('POST /ssh-key/rotate installs the new key once per account and records every site', async () => {
  await post('/sites', siteForm({ da_username: 'klant' }));
  await post('/sites', siteForm({ da_username: 'klant' }));
  await post('/sites', siteForm({ da_username: 'andere' }));
  await post('/sites', siteForm());
  const oldBlob = await activeBlob();
  calls = [];

  const res = await post('/ssh-key/rotate');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/ssh-key');
  const newBlob = await activeBlob();
  assert.notEqual(newBlob, oldBlob);
  assert.deepEqual(blobs('klant'), [newBlob]);
  assert.deepEqual(blobs('andere'), [newBlob]);
  // Grouped by account: one key listing per account, not per site.
  const listings = calls.filter((c) => c.cmd === 'CMD_SSH_KEYS' && c.method === 'GET').map((c) => c.as);
  assert.deepEqual(listings.sort(), ['andere', 'klant']);

  const rows = await sites();
  for (const s of rows.filter((r) => r.da_username)) {
    assert.equal(s.da_key_state.status, 'installed');
    assert.equal(s.da_key_state.removed_old, true);
  }
  assert.equal(rows.find((r) => !r.da_username).da_key_state, null);
});
