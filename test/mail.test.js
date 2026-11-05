// Route tests of mail per site on runs: real runner and checkout against a local fixture repo
// whose fake tools/deploy.sh and tools/update.sh echo their argv and the Resend key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const home = mkdtempSync(join(tmpdir(), 'mail-test-'));
mkdirSync(join(home, '.ssh'));
const data = join(home, 'data');
mkdirSync(data);
const fixture = join(home, 'fixture');
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: 'gh-test-token', BRICKS_LICENSE_KEY: 'bricks-test-licence',
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

const KEY = 're_test_d0main_key';
// The Stage 4 contract: mail flags on both theme types; a pluginless Bricks site fails on update.
const SCRIPT = `#!/bin/sh
echo "args: $*" >&2
echo "resend key: \${WOUTR_RESEND_API_KEY:-geen}" >&2
case "$*" in *--resend-*) [ -n "$WOUTR_RESEND_API_KEY" ] || { echo status=failed; echo error=no key; exit 2; } ;; esac
if [ "$3" = noplugin@host ] && [ "$(basename "$0")" = update.sh ]; then
  case "$*" in *--smtp-*|*--resend-*)
    echo status=failed; echo failed_step=guard
    echo "error=Fout: deze site heeft de WOUTR-plugin niet; mailinstellingen kunnen hier pas na installatie van de plugin."
    exit 2 ;;
  esac
fi
echo status=ok
echo "echoed=\${WOUTR_RESEND_API_KEY:-}"
case "$*" in *--smtp-*) echo smtp=configured ;; *) echo smtp=unchanged ;; esac
case "$*" in *--resend-*) echo resend=configured ;; *) echo resend=unchanged ;; esac
`;

function git(...args) {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: fixture, stdio: 'ignore' });
}

let app, base, cookie;
const post = (path, form = {}) => fetch(base + path, {
  method: 'POST', redirect: 'manual', body: new URLSearchParams(form), headers: { origin: base, cookie },
});
const get = (path) => fetch(base + path, { headers: { cookie } });

async function addSite({ theme = 'block', ssh = 'deploy@host', mail = 'resend' } = {}) {
  const { rows: [{ id }] } = await db.query(`INSERT INTO sites (client_slug, theme_type, ssh_target, wp_path, site_url, site_title, admin_email,
      smtp_host, smtp_pass_enc, mail_mode, resend_from, resend_from_name, resend_api_key_enc)
    VALUES ('acme', $1, $2, '/var/www', $3, 'Acme', 'a@acme.nl', 'mail.acme.nl', $4, $5, 'web@acme.nl', 'Acme', $6) RETURNING id`,
  [theme, ssh, `https://${randomBytes(4).toString('hex')}.nl`, encrypt('smtpgeheim', config.encryptionKey), mail, encrypt(KEY, config.encryptionKey)]);
  return id;
}

async function run(siteId, action, form = {}) {
  const res = await post(`/sites/${siteId}/run/${action}`, form);
  assert.equal(res.status, 302, await res.text());
  const runId = Number(res.headers.get('location').split('/').pop());
  let r;
  while ((r = (await db.query('SELECT * FROM runs WHERE id = $1', [runId])).rows[0]).status === 'running') await new Promise((ok) => setTimeout(ok, 20));
  return r;
}

before(async () => {
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', fixture]);
  for (const f of ['deploy.sh', 'update.sh']) writeFileSync(join(fixture, 'tools', f), SCRIPT);
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

test('deploy applies Resend on block and Bricks sites; the key only via the environment, masked', async () => {
  for (const theme of ['block', 'bricks']) {
    const id = await addSite({ theme });
    const r = await run(id, 'deploy');
    assert.equal(r.status, 'success', r.log);
    assert.equal(r.options.mail, 'resend');
    assert.match(r.log, /args: .*--resend-from web@acme\.nl --resend-from-name Acme/);
    assert.doesNotMatch(r.log, /--smtp-/);
    assert.match(r.log, /resend key: \[geheim\]/);
    assert.equal(r.result.echoed, '[geheim]');
    assert.equal(r.result.resend, 'configured');
    assert.ok(!JSON.stringify(r).includes(KEY), theme);
    assert.match(await (await get(`/sites/${id}/runs`)).text(), /Resend toegepast/);
  }
});

test('update applies mail only with the checkbox, and switches between SMTP and Resend', async () => {
  const id = await addSite();
  let r = await run(id, 'update');
  assert.equal(r.options.mail, undefined);
  assert.match(r.log, /resend key: geen/);
  assert.doesNotMatch(r.log, /--resend-|--smtp-/);

  r = await run(id, 'update', { apply_mail: '1' });
  assert.equal(r.options.mail, 'resend');
  assert.equal(r.result.resend, 'configured');

  await db.query("UPDATE sites SET mail_mode = 'smtp' WHERE id = $1", [id]);
  r = await run(id, 'update', { apply_mail: '1' });
  assert.equal(r.options.mail, 'smtp');
  assert.match(r.log, /--smtp-host mail\.acme\.nl/);
  assert.match(r.log, /resend key: geen/);
  assert.doesNotMatch(r.log, /--resend-/);
  assert.match(await (await get(`/sites/${id}/runs`)).text(), /SMTP toegepast/);
});

test('a site without mail sends no mail flags or mail secrets, even with stored values', async () => {
  const id = await addSite({ mail: 'none' });
  for (const [action, form] of [['deploy', {}], ['update', { apply_mail: '1' }]]) {
    const r = await run(id, action, form);
    assert.equal(r.status, 'success');
    assert.equal(r.options.mail, undefined);
    assert.doesNotMatch(r.log, /--resend-|--smtp-/);
    assert.match(r.log, /resend key: geen/);
  }
});

test('mail on a Bricks site without the plugin fails with the command\'s reason in log and notification', async () => {
  const id = await addSite({ theme: 'bricks', ssh: 'noplugin@host' });
  const page = await (await get(`/sites/${id}/run/update`)).text();
  assert.match(page, /Mailinstellingen \(Resend\) opnieuw toepassen/);
  assert.match(page, /Op een Bricks-site zonder de WOUTR-plugin mislukt dit/);
  const r = await run(id, 'update', { apply_mail: '1' });
  assert.equal(r.status, 'failed');
  assert.match(r.result.error, /WOUTR-plugin niet/);
  assert.match(await (await get(`/sites/${id}/runs/${r.id}`)).text(), /WOUTR-plugin niet/);
  const { rows: [n] } = await db.query("SELECT message FROM notifications WHERE site_id = $1 AND kind = 'run:update' AND resolved_at IS NULL", [id]);
  assert.match(n.message, /^Bijwerken mislukt \(run #\d+\): Fout: deze site heeft de WOUTR-plugin niet/);
});

test('the mail_mode backfill runs once: a deliberate Geen survives a reboot', async () => {
  const id = await addSite({ mail: 'none' });
  await initDb();
  assert.equal((await db.query('SELECT mail_mode FROM sites WHERE id = $1', [id])).rows[0].mail_mode, 'none');
});
