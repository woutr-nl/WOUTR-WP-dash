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
const { encrypt, decrypt } = await import('../src/crypto.js');
const { initSshKey, getKeyInfo } = await import('../src/sshkey.js');
const { keyBlob } = await import('../src/directadmin.js');
const { createApp } = await import('../src/app.js');

const db = new PGlite();
// Parameterless calls may hold several statements (initDb); PGlite runs those with exec.
const query = async (sql, params) => (params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) });
pool.query = query;
pool.connect = async () => ({ query, release() {} });

// Fake GitHub contents API for the client list (WOUTR-WP clients/ on main); all other
// fetches (the app itself, the fake panel) go to the real fetch.
let github;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.github.com') return realFetch(url, opts);
  if (github.fail) return new Response('{}', { status: github.fail });
  const m = u.pathname.match(/^\/repos\/woutr-nl\/WOUTR-WP\/contents\/clients(?:\/([^/]+)\/style\.css)?$/);
  if (!m || u.searchParams.get('ref') !== 'main') return new Response('{}', { status: 404 });
  if (!m[1]) return Response.json([...Object.keys(github.clients).map((name) => ({ name, type: 'dir' })), { name: 'README.md', type: 'file' }]);
  const css = github.clients[decodeURIComponent(m[1])];
  return css == null ? new Response('{}', { status: 404 }) : new Response(css);
};
const css = (template) => `/*\n Theme Name: X\n Template: ${template}\n*/\n`;

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
    if (u?.fail) { res.writeHead(401); return res.end(); }
    if (cmd === 'CMD_API_SHOW_DOMAINS') return send({ list: u.domains });
    if (cmd === 'CMD_API_DATABASES' && req.method === 'GET') return send({ list: u.databases });
    if (cmd === 'CMD_API_DATABASES' && params.action === 'create') {
      const name = `${as}_${params.name}`;
      if (u.denyCreate || u.databases.includes(name)) return send({ error: '1', text: `Kan ${name} niet aanmaken`, details: `wachtwoord ${params.passwd}` });
      u.databases.push(name);
      return send({ error: '0' });
    }
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
  accounts = {
    klant: { keys: {}, domains: ['klant1.invalid', 'klant2.invalid', 'voorbeeld.invalid'], databases: ['klant_oud'] },
    andere: { keys: {}, domains: ['andere.invalid'], databases: [] },
  };
  github = { fail: 0, clients: { acme: css('woutr'), innerhaven: css('woutr'), 'innerhaven-bricks': css('bricks'), vensa: css('woutr'), raar: css('twentytwentyfive') } };
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
  client_slug: 'acme', theme_type: 'block', ssh_target: 'deploy@255.255.255.255', wp_path: '/var/www',
  site_url: `https://acme${++n}.nl`, site_title: 'Acme', admin_email: 'a@acme.nl', ...extra,
});
const sites = async () => (await db.query('SELECT id, site_url, da_username, da_key_state FROM sites ORDER BY id')).rows;
const blobs = (user) => Object.values(accounts[user].keys).map((k) => keyBlob(k.key));
const activeBlob = async () => keyBlob((await getKeyInfo()).public_key);

test('site save with da_username installs the key and records da_key_state; clearing it resets the state', async () => {
  const res = await post('/sites', siteForm({ da_username: 'klant', da_domain: 'klant1.invalid' }));
  assert.equal(res.status, 302);
  const [site] = await sites();
  assert.equal(site.da_key_state.status, 'installed');
  // The derived SSH target is on .invalid: it never resolves, so no real sshd is ever reached.
  assert.equal(site.da_key_state.ssh_test.outcome, 'unreachable');
  assert.deepEqual(blobs('klant'), [await activeBlob()]);

  const edit = await post(`/sites/${site.id}`, siteForm({ site_url: site.site_url, da_username: '' }));
  assert.equal(edit.status, 302);
  const [cleared] = await sites();
  assert.equal(cleared.da_username, null);
  assert.equal(cleared.da_key_state, null);
});

test('site is still saved when the key installation fails', async () => {
  // An unlisted account is only accepted as an existing site's stored value.
  await post('/sites', siteForm());
  const [plain] = await sites();
  await db.query('UPDATE sites SET da_username = $2 WHERE id = $1', [plain.id, 'onbekend']);
  const res = await post(`/sites/${plain.id}`, siteForm({ site_url: plain.site_url, da_username: 'onbekend' }));
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
  await post('/sites', siteForm({ da_username: 'klant', da_domain: 'klant1.invalid' }));
  await post('/sites', siteForm({ da_username: 'klant', da_domain: 'klant2.invalid' }));
  await post('/sites', siteForm({ da_username: 'andere', da_domain: 'andere.invalid' }));
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

test('POST /instellingen only keeps the stored secret for the same panel URL and username', async () => {
  const daRow = async () => (await db.query('SELECT url, username, password_enc FROM directadmin')).rows[0];
  const orig = await daRow();
  try {
    await db.query("UPDATE directadmin SET url = 'https://da.voorbeeld.invalid:2222'");
    const stored = await daRow();

    for (const form of [{ url: 'https://aanvaller.nl', username: 'res' }, { url: stored.url, username: 'ander' }]) {
      const res = await post('/instellingen', { ...form, password: '' });
      assert.equal(res.status, 422);
      assert.match(await res.text(), /opnieuw in als je de panel-URL of gebruikersnaam wijzigt/);
      assert.deepEqual(await daRow(), stored);
    }

    assert.equal((await post('/instellingen', { url: stored.url, username: 'res', password: '' })).status, 302);
    assert.equal((await daRow()).password_enc, stored.password_enc);

    assert.equal((await post('/instellingen', { url: 'https://nieuw.nl', username: 'res', password: 'n13uw' })).status, 302);
    const changed = await daRow();
    assert.equal(changed.url, 'https://nieuw.nl');
    assert.equal(decrypt(changed.password_enc, config.encryptionKey), 'n13uw');
  } finally {
    await db.query('UPDATE directadmin SET url = $1, username = $2, password_enc = $3', [orig.url, orig.username, orig.password_enc]);
  }
});

const get = (path) => fetch(base + path, { redirect: 'manual', headers: { cookie } });
const row = async (id) => (await db.query('SELECT * FROM sites WHERE id = $1', [id])).rows[0];
const onlySite = async () => (await db.query('SELECT * FROM sites')).rows[0];
const daForm = (extra = {}) => siteForm({ da_username: 'klant', da_domain: 'voorbeeld.invalid', ...extra });

test('the form offers the client folders; the theme type comes from style.css, never from the POST', async () => {
  const html = await (await get('/sites/new')).text();
  for (const slug of ['innerhaven', 'innerhaven-bricks', 'vensa']) assert.match(html, new RegExp(`<option value="${slug}" data-theme`));
  assert.match(html, /<option value="raar" data-theme="" disabled\s*>raar \(thematype onbekend\)/);
  assert.doesNotMatch(html, /value="README.md"/);

  // Bricks slug + posted 'block' + SMTP: stored as bricks, so the SMTP rule applies.
  const smtp = await post('/sites', siteForm({ client_slug: 'innerhaven-bricks', theme_type: 'block', smtp_host: 'mail.x.nl' }));
  assert.equal(smtp.status, 422);
  assert.match(await smtp.text(), /niet mogelijk bij een Bricks-thema/);
  assert.equal((await post('/sites', siteForm({ client_slug: 'innerhaven-bricks', theme_type: 'block' }))).status, 302);
  assert.equal((await onlySite()).theme_type, 'bricks');
  await db.query('DELETE FROM sites');
  assert.equal((await post('/sites', siteForm({ client_slug: 'vensa', theme_type: 'bricks' }))).status, 302);
  assert.equal((await onlySite()).theme_type, 'block');

  for (const slug of ['raar', 'bestaat-niet']) {
    const res = await post('/sites', siteForm({ client_slug: slug }));
    assert.equal(res.status, 422);
    assert.match(await res.text(), /Onbekende klant-slug/);
  }
});

test('a failing client list blocks new sites; an existing site keeps its slug and theme type', async () => {
  await post('/sites', siteForm({ client_slug: 'innerhaven-bricks' }));
  const site = await onlySite();
  github.fail = 500;
  const page = await (await get('/sites/new')).text();
  assert.match(page, /De klantenlijst kon niet worden geladen uit WOUTR-WP/);
  const res = await post('/sites', siteForm({ client_slug: 'vensa' }));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /De klantenlijst kon niet worden geladen; een nieuwe klant-slug/);
  assert.equal((await get(`/sites/${site.id}/edit`)).status, 200);
  assert.equal((await post(`/sites/${site.id}`, siteForm({ client_slug: 'innerhaven-bricks', site_url: site.site_url, site_title: 'Nieuw' }))).status, 302);
  const kept = await row(site.id);
  assert.equal(kept.theme_type, 'bricks');
  assert.equal(kept.site_title, 'Nieuw');
  assert.equal((await post(`/sites/${site.id}`, siteForm({ client_slug: 'vensa', site_url: site.site_url }))).status, 422);
});

test('account + domain: hosting fields are derived on the server, whatever the POST says', async () => {
  const res = await post('/sites', daForm({ ssh_target: 'evil@elders.nl', wp_path: '/tmp', site_url: 'https://elders.nl' }));
  assert.equal(res.status, 302);
  const s = await onlySite();
  assert.equal(s.ssh_target, 'klant@voorbeeld.invalid');
  assert.equal(s.wp_path, '/home/klant/domains/voorbeeld.invalid/public_html');
  assert.equal(s.site_url, 'https://voorbeeld.invalid');
  assert.equal(s.da_domain, 'voorbeeld.invalid');

  assert.match(await (await post('/sites', daForm({ da_domain: 'elders.nl' }))).text(), /Domein niet gevonden/);
  assert.match(await (await post('/sites', daForm({ da_domain: '' }))).text(), /Kies een domein/);
  assert.match(await (await post('/sites', daForm({ da_username: 'onbekend' }))).text(), /Hosting-account niet gevonden/);
});

test('domain list failure: an unchanged site saves, a changed domain gets the DirectAdmin reason', async () => {
  await post('/sites', daForm());
  const s = await onlySite();
  accounts.klant.fail = true;
  assert.equal((await post(`/sites/${s.id}`, daForm({ site_title: 'Bewaard' }))).status, 302);
  assert.equal((await row(s.id)).site_title, 'Bewaard');
  const res = await post(`/sites/${s.id}`, daForm({ da_domain: 'klant1.invalid' }));
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Inloggegevens geweigerd/);
  assert.equal((await row(s.id)).da_domain, 'voorbeeld.invalid');

  // Legacy site with an account but no domain stays manual while untouched.
  await db.query('UPDATE sites SET da_domain = NULL, wp_path = $2 WHERE id = $1', [s.id, '/home/klant/oud']);
  const legacy = { ssh_target: s.ssh_target, wp_path: '/home/klant/oud', site_url: s.site_url, da_domain: '' };
  assert.equal((await post(`/sites/${s.id}`, daForm(legacy))).status, 302);
  assert.equal((await row(s.id)).wp_path, '/home/klant/oud');
  assert.equal((await post(`/sites/${s.id}`, daForm({ ...legacy, wp_path: '/elders' }))).status, 422);
});

test('db_mode=create makes the database through DirectAdmin and stores it encrypted', async () => {
  const res = await post('/sites', daForm({ client_slug: 'innerhaven-bricks', db_mode: 'create', db_name: 'x', db_user: 'y', db_pass: 'z' }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const s = await onlySite();
  assert.equal(s.db_name, 'klant_innerhavenbr');
  assert.equal(s.db_user, 'klant_innerhavenbr');
  assert.equal(s.db_host, 'localhost');
  assert.equal(s.db_create_error, null);
  const create = calls.find((c) => c.cmd === 'CMD_API_DATABASES' && c.method === 'POST');
  assert.equal(create.as, 'klant');
  assert.deepEqual([create.params.name, create.params.user], ['innerhavenbr', 'innerhavenbr']);
  const pass = decrypt(s.db_pass_enc, config.encryptionKey);
  assert.equal(create.params.passwd, pass);
  assert.equal(create.params.passwd2, pass);
  assert.match(pass, /^[A-Za-z0-9]{24}$/);
  assert.doesNotMatch(await (await get(`/sites/${s.id}/edit`)).text(), new RegExp(pass));

  // Same slug, same account: the next free name.
  await post('/sites', daForm({ client_slug: 'innerhaven-bricks', da_domain: 'klant1.invalid', db_mode: 'create' }));
  const second = (await db.query('SELECT db_name FROM sites WHERE da_domain = $1', ['klant1.invalid'])).rows[0];
  assert.equal(second.db_name, 'klant_innerhavenbr2');
});

test('a failed database creation keeps the site and shows the reason on the edit form', async () => {
  accounts.klant.denyCreate = true;
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await post('/sites', daForm({ db_mode: 'create' }));
  } finally {
    console.error = orig;
  }
  assert.equal(res.status, 302);
  const s = await onlySite();
  assert.equal(res.headers.get('location'), `/sites/${s.id}/edit`);
  assert.equal(s.db_name, null);
  assert.equal(s.db_pass_enc, null);
  assert.match(s.db_create_error, /^DirectAdmin weigerde de database aan te maken\. \(Kan klant_acme niet aanmaken: wachtwoord \*\*\*\)$/);
  const pass = calls.find((c) => c.params.action === 'create').params.passwd;
  assert.ok(!logs.join('\n').includes(pass));
  assert.match(await (await get(`/sites/${s.id}/edit`)).text(), /Database aanmaken is mislukt: DirectAdmin weigerde/);

  // Retry from the edit form.
  accounts.klant.denyCreate = false;
  assert.equal((await post(`/sites/${s.id}`, daForm({ site_url: s.site_url, db_mode: 'create' }))).status, 302);
  const ok = await row(s.id);
  assert.equal(ok.db_name, 'klant_acme');
  assert.equal(ok.db_create_error, null);
});

test('db_mode=existing accepts a listed database only', async () => {
  const bad = await post('/sites', daForm({ db_mode: 'existing', db_name: 'klant_nep', db_user: 'klant_nep' }));
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /Onbekende database op dit account/);
  assert.equal((await post('/sites', daForm({ db_mode: 'existing', db_name: 'klant_oud', db_user: 'klant_oud', db_pass: 'pw1' }))).status, 302);
  const s = await onlySite();
  assert.equal(s.db_name, 'klant_oud');
  assert.equal(decrypt(s.db_pass_enc, config.encryptionKey), 'pw1');
  assert.ok(!calls.some((c) => c.params.action === 'create'));
});

test('GET /da/accounts/:user lists domains and databases', async () => {
  assert.deepEqual(await (await get('/da/accounts/klant')).json(),
    { ok: true, domains: ['klant1.invalid', 'klant2.invalid', 'voorbeeld.invalid'], databases: ['klant_oud'], error: null });
  assert.equal((await get('/da/accounts/Bad-User')).status, 404);
  assert.equal((await fetch(`${base}/da/accounts/klant`, { redirect: 'manual' })).status, 302);
  accounts.klant.fail = true;
  const r = await (await get('/da/accounts/klant')).json();
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Inloggegevens geweigerd door het DirectAdmin-paneel.');
});

test('without a reseller connection the hosting fields stay free text', async () => {
  const daRow = (await db.query('SELECT * FROM directadmin')).rows[0];
  await db.query('DELETE FROM directadmin');
  try {
    const html = await (await get('/sites/new')).text();
    assert.match(html, /<input name="da_username"/);
    assert.doesNotMatch(html, /name="db_mode"/);
    assert.equal((await post('/sites', siteForm({ ssh_target: 'deploy@host.nl', wp_path: '/var/www/x', da_username: 'iemand', db_mode: 'create' }))).status, 302);
    const s = await onlySite();
    assert.deepEqual([s.ssh_target, s.wp_path, s.da_username, s.db_name], ['deploy@host.nl', '/var/www/x', 'iemand', null]);
    assert.equal((await post('/sites', siteForm({ ssh_target: '-oProxyCommand=x' }))).status, 422);
  } finally {
    await db.query('INSERT INTO directadmin (url, username, password_enc) VALUES ($1, $2, $3)', [daRow.url, daRow.username, daRow.password_enc]);
  }
});

test('the edit form keeps a stored slug or account that is not in the lists, marked as not found', async () => {
  await post('/sites', siteForm());
  const s = await onlySite();
  await db.query('UPDATE sites SET client_slug = $2, theme_type = $3, da_username = $4 WHERE id = $1', [s.id, 'verdwenen', 'bricks', 'weg']);
  const html = await (await get(`/sites/${s.id}/edit`)).text();
  assert.match(html, /<option value="verdwenen" data-theme="bricks" selected>verdwenen \(niet gevonden onder clients\/\)<\/option>/);
  assert.match(html, /<option value="weg" selected>weg \(niet gevonden onder de reseller\)<\/option>/);
  // Listed values get no marker.
  assert.doesNotMatch(html, /klant \(niet gevonden/);
});
