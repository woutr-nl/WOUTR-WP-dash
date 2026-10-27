// Route test of POST /sites/:id/wp-login: real runner and checkout refresh against a local
// fixture repo whose fake tools/login.sh checks the argv contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const home = mkdtempSync(join(tmpdir(), 'wp-login-test-'));
mkdirSync(join(home, '.ssh'));
const data = join(home, 'data');
mkdirSync(data);
const fixture = join(home, 'fixture');
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: 'd', BRICKS_LICENSE_KEY: 'e',
  DATA_DIR: data, WOUTR_WP_GIT_URL: fixture,
});
const { default: config } = await import('../src/config.js');
const { pool, initDb } = await import('../src/db.js');
const { encrypt } = await import('../src/crypto.js');
const { initSshKey } = await import('../src/sshkey.js');
const { createApp } = await import('../src/app.js');

const db = new PGlite();
const query = async (sql, params) => (params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) });
pool.query = query;
pool.connect = async () => ({ query, release() {} });

const LOGIN_SH = `#!/bin/sh
[ "$#" -eq 6 ] && [ "$1" = --ssh ] && [ "$3" = --path ] && [ "$5" = --admin-user ] || { echo status=failed; echo failed_step=validate; echo error=bad args; exit 2; }
if [ "$2" = fail@host ]; then
  echo "verbinden met $2…" >&2
  echo status=failed; echo failed_step=ssh; echo error=De server is niet bereikbaar.; exit 1
fi
echo status=ok
echo login_url=https://acme.example/?woutr_login=TESTTOKEN
`;

function git(...args) {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: fixture, stdio: 'ignore' });
}

let app, base, cookie;
const post = (path, withCookie = true) => fetch(base + path, {
  method: 'POST', redirect: 'manual', headers: { origin: base, ...(withCookie && { cookie }) },
});
async function addSite(sshTarget, deployed = true) {
  const { rows: [{ id }] } = await db.query(`INSERT INTO sites (client_slug, theme_type, ssh_target, wp_path, site_url, site_title, admin_email, admin_pass_enc)
    VALUES ('acme', 'block', $1, '/var/www', $2, 'Acme', 'a@acme.nl', $3) RETURNING id`,
  [sshTarget, `https://${randomBytes(4).toString('hex')}.nl`, deployed ? encrypt('geheim', config.encryptionKey) : null]);
  return id;
}

before(async () => {
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', fixture]);
  writeFileSync(join(fixture, 'tools', 'login.sh'), LOGIN_SH);
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
  await initDb();
  await initSshKey();
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
  const res = await fetch(base + '/login', {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: 'admin', password: 'pw' }), headers: { origin: base },
  });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
});
after(() => app.close());

test('returns the login URL from tools/login.sh (clone, then fetch on the second call)', async () => {
  const id = await addSite('deploy@acme.example');
  for (let i = 0; i < 2; i++) {
    const res = await post(`/sites/${id}/wp-login`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, login_url: 'https://acme.example/?woutr_login=TESTTOKEN' });
  }
  // Not a run: nothing recorded.
  assert.equal((await db.query('SELECT 1 FROM runs')).rows.length, 0);
});

test('a remote failure returns the Dutch error from the script', async () => {
  const id = await addSite('fail@host');
  assert.deepEqual(await (await post(`/sites/${id}/wp-login`)).json(), { ok: false, message: 'De server is niet bereikbaar.' });
});

test('an unauthenticated request is redirected to the login page', async () => {
  const id = await addSite('deploy@acme.example');
  const res = await post(`/sites/${id}/wp-login`, false);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('a site that was never deployed gets 409; an unknown site 404', async () => {
  const id = await addSite('deploy@acme.example', false);
  const res = await post(`/sites/${id}/wp-login`);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { ok: false, message: 'Deze site is nog niet gedeployed.' });
  const missing = await post('/sites/999999/wp-login');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Niet gevonden.' });
});
