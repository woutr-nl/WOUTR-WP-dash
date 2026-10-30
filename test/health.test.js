// Health check + notifications: real schema and SQL on PGlite, fake sites over HTTP(S), the
// app on an ephemeral port, the real runner against a local fixture repo.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';

const home = mkdtempSync(join(tmpdir(), 'health-test-'));
mkdirSync(join(home, '.ssh'));
const data = join(home, 'data');
mkdirSync(data);
const fixture = join(home, 'fixture');
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: 'd', BRICKS_LICENSE_KEY: 'e',
  DATA_DIR: data, WOUTR_WP_GIT_URL: fixture,
});
const { pool, initDb } = await import('../src/db.js');
const { initSshKey } = await import('../src/sshkey.js');
const { createApp } = await import('../src/app.js');
const { sweep, checkSite, classifyCert, probeTls, probes } = await import('../src/health.js');
const { runFinished, markInterruptedRuns, purgeOld, openCount } = await import('../src/notifications.js');
const { LOCALHOST_KEY, LOCALHOST_CERT } = await import('./certs.js');

const db = new PGlite();
const query = async (sql, params) => (params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) });
pool.query = query;
pool.connect = async () => ({ query, release() {} });

const WP_NOINDEX = `<html><head><meta name='robots' content='noindex, nofollow' /></head></html>`;

// Fake sites: the handler is swapped per test; requests counts what reached them.
let handler, requests;
const serve = (req, res) => { requests++; handler(req, res); };
const web = createServer(serve);
const secure = createHttpsServer({ key: LOCALHOST_KEY, cert: LOCALHOST_CERT }, serve);
const ok = (req, res) => res.end('<html><head><meta name="robots" content="max-image-preview:large"></head></html>');
const down = (req) => req.socket.destroy();

let app, base, cookie, webUrl, secureUrl;
before(async () => {
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', fixture]);
  writeFileSync(join(fixture, 'tools', 'live.sh'), 'case "$*" in *fail@*) exit 1 ;; *confirm@*) exit 3 ;; esac\necho status=ok\n');
  execFileSync('git', ['add', '.'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture'], { cwd: fixture });
  await initDb();
  await initSshKey();
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  await new Promise((r) => secure.listen(0, r));
  webUrl = `http://127.0.0.1:${web.address().port}`;
  secureUrl = `https://localhost:${secure.address().port}`;
  app = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${app.address().port}`;
  const res = await post('/login', { username: 'admin', password: 'pw' });
  cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
});
after(() => {
  app.close();
  web.closeAllConnections();
  web.close();
  secure.closeAllConnections();
  secure.close();
});

beforeEach(async () => {
  handler = ok;
  requests = 0;
  await db.query('DELETE FROM sites');
});

function post(path, form = {}) {
  return fetch(base + path, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams(form),
    headers: { origin: base, ...(cookie && { cookie }) },
  });
}
const page = async (path) => (await fetch(base + path, { headers: { cookie } })).text();
const check = async (id) => (await post(`/sites/${id}/check`)).json();

async function addRun(id, action, status) {
  const { rows: [{ id: runId }] } = await db.query('INSERT INTO runs (site_id, action, status) VALUES ($1, $2, $3) RETURNING id', [id, action, status]);
  return runId;
}
async function addSite({ url = webUrl, deployed = true, live = false, ssh = 'deploy@host', title = 'Acme' } = {}) {
  const { rows: [{ id }] } = await db.query(`INSERT INTO sites (client_slug, theme_type, ssh_target, wp_path, site_url, site_title, admin_email)
    VALUES ('acme', 'block', $1, '/var/www', $2, $3, 'a@acme.nl') RETURNING id`, [ssh, url, title]);
  if (deployed) await addRun(id, 'deploy', 'success');
  if (live) await addRun(id, 'live', 'success');
  return id;
}
const health = async (id) => (await db.query('SELECT health FROM sites WHERE id = $1', [id])).rows[0].health;
const notifications = async (id) => (await db.query('SELECT * FROM notifications WHERE site_id = $1 ORDER BY id', [id])).rows;
const openOf = async (id) => (await notifications(id)).filter((n) => !n.resolved_at && !n.dismissed_at);
const counter = (html) => Number(html.match(/href="\/meldingen">Meldingen(?: <span class="badge failed">(\d+)<\/span>)?/)?.[1] ?? 0);
const days = (n) => new Date(Date.now() + n * 864e5).toUTCString();
const FACTS = (validTo) => ({ ok: true, authorized: true, validTo });
function stubCert(t, facts) {
  const real = probes.tls;
  probes.tls = async () => facts();
  t.after(() => { probes.tls = real; });
}

test('sites without a successful deploy are never checked', async () => {
  const id = await addSite({ deployed: false });
  await addRun(id, 'deploy', 'failed');
  await sweep();
  assert.equal(requests, 0);
  assert.equal(await health(id), null);
  assert.deepEqual(await check(id), { ok: false, message: 'Deze site is nog niet gedeployed.' });
  assert.equal(requests, 0);
  assert.doesNotMatch(await page(`/sites/${id}/runs`), /Nu controleren/);
});

test('a healthy site: ok result on the overview and per check on the runs page, no notification, no run row', async () => {
  const id = await addSite();
  await sweep();
  const h = await health(id);
  assert.equal(h.status, 'ok');
  assert.equal(h.checks.reachable.status, 'ok');
  assert.equal(h.checks.cert.status, 'skipped');
  assert.equal(h.checks.noindex.status, 'skipped');
  assert.deepEqual(await notifications(id), []);
  const overview = await page('/');
  assert.match(overview, /<th>Gezondheid<\/th>/);
  assert.match(overview, /badge success">OK<\/span><br>\s*<small>\d/);
  const runsPage = await page(`/sites/${id}/runs`);
  for (const label of ['Bereikbaar', 'Certificaat', 'Indexering', 'Nu controleren', `data-test="/sites/${id}/check"`]) assert.ok(runsPage.includes(label), label);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM runs WHERE site_id = $1', [id]);
  assert.equal(rows[0].n, 1, 'only the seeded deploy run');
});

test('a site not checked yet shows the button and no result', async () => {
  const id = await addSite();
  const html = await page(`/sites/${id}/runs`);
  assert.match(html, /Nog niet gecontroleerd/);
  assert.match(html, /Nu controleren/);
});

test('the check does not wait for a running run and writes no run', async () => {
  const id = await addSite();
  await addRun(id, 'update', 'running');
  const res = await check(id);
  assert.equal(res.ok, true);
  assert.match(res.message, /Bereikbaar: OK/);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM runs WHERE site_id = $1', [id]);
  assert.equal(rows[0].n, 2);
});

test('unreachable: notifies after two consecutive failures, stays one, resolves when back', async () => {
  const id = await addSite({ title: 'Kapot & Co' });
  handler = down;
  await check(id);
  assert.equal((await health(id)).checks.reachable.fails, 1);
  assert.equal((await health(id)).status, 'problem', 'the raw result shows before the notification');
  assert.deepEqual(await notifications(id), []);
  assert.equal(counter(await page('/')), 0);

  await check(id);
  let [n, ...rest] = await notifications(id);
  assert.deepEqual(rest, []);
  assert.equal(n.kind, 'health:reachable');
  assert.equal(n.severity, 'problem');
  assert.match(n.message, /^Site niet bereikbaar \(/);
  let html = await page('/meldingen');
  assert.equal(counter(html), 1);
  assert.ok(html.includes('Kapot &amp; Co'));
  assert.ok(html.includes(n.message));
  assert.match(html, /sinds \d/);
  assert.ok(html.includes(`href="/sites/${id}/runs">Bekijk site`));

  await check(id);
  assert.equal((await notifications(id)).length, 1, 'no duplicates while it persists');
  assert.equal(new Date((await notifications(id))[0].created_at).getTime(), new Date(n.created_at).getTime());

  handler = ok;
  await check(id);
  assert.ok((await notifications(id))[0].resolved_at);
  assert.equal((await health(id)).checks.reachable.fails, 0);
  html = await page('/meldingen');
  assert.equal(counter(html), 0);
  assert.match(html, /Geen open meldingen/);
  assert.match(html, /opgelost \d/);
});

test('one failure between passes never notifies; a 5xx and a refused connection count as failures', async () => {
  const id = await addSite();
  for (handler of [down, ok, down, ok]) await check(id);
  assert.deepEqual(await notifications(id), []);
  handler = (req, res) => { res.writeHead(503); res.end(); };
  assert.match((await check(id)).message, /Bereikbaar: HTTP 503/);
  const refused = await addSite({ url: 'http://127.0.0.1:1' });
  assert.match((await check(refused)).message, /Bereikbaar: verbinding geweigerd/);
});

test('redirects are followed, a 3xx without location counts as an answer, a loop fails', async () => {
  const id = await addSite({ live: true });
  handler = (req, res) => {
    if (req.url === '/') { res.writeHead(301, { location: '/home' }); return res.end(); }
    res.end(WP_NOINDEX);
  };
  await check(id);
  assert.equal((await health(id)).checks.reachable.status, 'ok');
  assert.equal((await health(id)).checks.noindex.status, 'failed', 'judged on the final page');
  handler = (req, res) => { res.writeHead(304); res.end(); };
  await check(id);
  assert.equal((await health(id)).checks.reachable.status, 'ok');
  handler = (req, res) => { res.writeHead(302, { location: '/' }); res.end(); };
  await check(id);
  assert.equal((await health(id)).checks.reachable.detail, 'te veel doorverwijzingen');
});

test('a body beyond the cap still counts as an answer', async () => {
  const id = await addSite();
  handler = (req, res) => res.end(Buffer.alloc(2 * 1024 * 1024, 'x'));
  await check(id);
  assert.equal((await health(id)).checks.reachable.status, 'ok');
});

test('a hanging site does not delay the others and times out', { timeout: 20_000 }, async () => {
  const slow = await addSite({ url: `${webUrl}/slow` });
  const fast = await addSite({ url: `${webUrl}/fast` });
  handler = (req, res) => { if (req.url === '/fast') ok(req, res); };
  const done = sweep();
  while (!await health(fast)) await sleep(20);
  assert.equal(await health(slow), null, 'the slow site is still being checked');
  await done;
  assert.equal((await health(slow)).checks.reachable.detail, 'time-out');
});

test('a second check of the same site at the same time is refused', async () => {
  const id = await addSite();
  let release;
  const gate = new Promise((r) => { release = r; });
  handler = (req, res) => gate.then(() => ok(req, res));
  const first = check(id);
  while (!requests) await sleep(5);
  const res = await post(`/sites/${id}/check`);
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /al een controle/);
  release();
  assert.equal((await first).ok, true);
});

for (const [name, serveNoindex] of [
  ['meta tag', (req, res) => res.end(WP_NOINDEX)],
  ['X-Robots-Tag header', (req, res) => { res.setHeader('X-Robots-Tag', 'noindex'); res.end('<html></html>'); }],
]) {
  test(`noindex via ${name}: notifies a live site after two checks, never a site that isn't live`, async () => {
    handler = serveNoindex;
    const live = await addSite({ url: `${webUrl}/live`, live: true });
    const notLive = await addSite({ url: `${webUrl}/deployed` });
    await sweep();
    assert.deepEqual(await notifications(live), []);
    await sweep();
    const [n] = await notifications(live);
    assert.equal(n.kind, 'health:noindex');
    assert.equal((await health(notLive)).checks.noindex.status, 'skipped');
    assert.equal((await health(notLive)).status, 'ok');
    assert.deepEqual(await notifications(notLive), []);
    handler = ok;
    await sweep();
    assert.ok((await notifications(live))[0].resolved_at);
  });
}

test('a later failed live run still counts as live for the noindex check', async () => {
  const id = await addSite({ live: true });
  await addRun(id, 'live', 'failed');
  handler = (req, res) => res.end(WP_NOINDEX);
  await check(id);
  await check(id);
  assert.equal((await openOf(id)).length, 1);
});

test('an unreachable live site leaves the noindex check unknown, keeping its streak', async () => {
  const id = await addSite({ live: true });
  handler = (req, res) => res.end(WP_NOINDEX);
  await check(id);
  handler = down;
  await check(id);
  const c = (await health(id)).checks.noindex;
  assert.equal(c.status, 'skipped');
  assert.equal(c.fails, 1);
  assert.deepEqual(await notifications(id), []);
});

test('dismissed health problem: stays away while it persists, returns only after a pass and two new failures', async () => {
  const id = await addSite();
  handler = down;
  await check(id);
  await check(id);
  const [n] = await notifications(id);
  assert.equal(counter(await page('/')), 1);
  assert.equal((await post(`/meldingen/${n.id}/afvinken`)).headers.get('location'), '/meldingen');
  const html = await page('/meldingen');
  assert.equal(counter(html), 0);
  assert.match(html, /afgevinkt \d/);
  assert.doesNotMatch(html, /meldingen\/\d+\/afvinken/);

  await check(id);
  assert.equal(await openCount(), 0);
  assert.equal((await notifications(id)).length, 1);

  handler = ok;
  await check(id);
  assert.ok((await notifications(id))[0].resolved_at);
  handler = down;
  await check(id);
  assert.equal(await openCount(), 0);
  await check(id);
  assert.equal((await openOf(id)).length, 1);
  assert.equal((await notifications(id)).length, 2);
});

test('an old dismissal keeps blocking a persisting problem but leaves the page', async () => {
  const id = await addSite();
  handler = down;
  await check(id);
  await check(id);
  const [n] = await notifications(id);
  await post(`/meldingen/${n.id}/afvinken`);
  await db.query(`UPDATE notifications SET dismissed_at = now() - interval '31 days'`);
  await purgeOld();
  await check(id);
  assert.equal((await notifications(id)).length, 1);
  assert.equal(await openCount(), 0);
  assert.ok(!(await page('/meldingen')).includes(n.message));
});

test('afvinken of an unknown or malformed id changes nothing', async () => {
  assert.equal((await post('/meldingen/999/afvinken')).status, 302);
  assert.equal((await post('/meldingen/abc/afvinken')).status, 404);
});

test('classifyCert', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  const at = (d) => new Date(now.getTime() + d * 864e5).toUTCString();
  assert.equal(classifyCert(FACTS(at(30)), now).status, 'ok');
  assert.equal(classifyCert(FACTS(at(14.5)), now).status, 'ok');
  const warning = classifyCert(FACTS(at(13)), now);
  assert.equal(warning.status, 'warning');
  assert.match(warning.detail, /^verloopt op 14-6-2026$/);
  assert.equal(classifyCert(FACTS(at(-1)), now).status, 'failed');
  assert.match(classifyCert({ ok: true, authorized: false, authorizationError: 'CERT_HAS_EXPIRED', validTo: at(-1) }, now).detail, /verlopen op/);
  assert.match(classifyCert({ ok: true, authorized: false, authorizationError: 'SELF_SIGNED', validTo: at(90) }, now).detail, /SELF_SIGNED/);
  assert.match(classifyCert({ ...FACTS(at(90)), hostError: 'wrong host' }, now).detail, /wrong host/);
  assert.match(classifyCert({ ok: false, error: 'time-out' }, now).detail, /kon certificaat niet controleren: time-out/);
  assert.equal(classifyCert({ ok: true, authorized: false }, now).status, 'failed');
});

test('probeTls reports a self-signed certificate and a host mismatch', async () => {
  const facts = await probeTls('localhost', secure.address().port);
  assert.equal(facts.ok, true);
  assert.equal(facts.authorized, false);
  assert.match(facts.authorizationError, /SELF_SIGNED/);
  assert.ok(!facts.hostError);
  assert.ok(facts.validTo);
  assert.ok((await probeTls('127.0.0.1', secure.address().port)).hostError);
  assert.equal((await probeTls('localhost', 1)).ok, false);
});

test('expiring certificate warns on the first check; renewal resolves on the next', async (t) => {
  let facts = FACTS(days(10));
  stubCert(t, () => facts);
  const id = await addSite({ url: secureUrl });
  await check(id);
  assert.equal((await health(id)).status, 'warning');
  let [n] = await notifications(id);
  assert.equal(n.kind, 'health:cert');
  assert.equal(n.severity, 'warning');
  assert.match(n.message, /^SSL-certificaat verloopt op /);
  assert.match(await page('/meldingen'), /badge warning">Waarschuwing/);
  assert.match(await page('/'), /badge warning">Waarschuwing/);
  facts = FACTS(days(90));
  await check(id);
  [n] = await notifications(id);
  assert.ok(n.resolved_at);
});

test('expired certificate needs two checks; a warning flips to problem on the same row', async (t) => {
  let facts = FACTS(days(-1));
  stubCert(t, () => facts);
  const id = await addSite({ url: secureUrl });
  await check(id);
  assert.deepEqual(await notifications(id), []);
  await check(id);
  assert.equal((await openOf(id))[0].severity, 'problem');

  const other = await addSite({ url: `${secureUrl}/other` });
  facts = FACTS(days(5));
  await check(other);
  const [warning] = await notifications(other);
  assert.equal(warning.severity, 'warning');
  facts = FACTS(days(-1));
  await check(other);
  assert.equal((await notifications(other))[0].severity, 'warning', 'the first failure changes nothing yet');
  await check(other);
  const rows = await notifications(other);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, warning.id);
  assert.equal(rows[0].severity, 'problem');
  assert.match(rows[0].message, /^SSL-certificaat ongeldig of verlopen \(/);
  assert.equal(new Date(rows[0].created_at).getTime(), new Date(warning.created_at).getTime());
});

test('a site answering 200 with an invalid certificate only gets a certificate notification', async () => {
  const id = await addSite({ url: secureUrl, live: true });
  await check(id);
  const res = await check(id);
  assert.equal(res.ok, false);
  const { checks } = await health(id);
  assert.equal(checks.reachable.status, 'ok');
  assert.equal(checks.cert.status, 'failed');
  assert.equal(checks.noindex.status, 'ok');
  assert.deepEqual((await notifications(id)).map((n) => n.kind), ['health:cert']);
});

test('failed and interrupted runs notify with a link; a later success of that action resolves', async () => {
  const id = await addSite();
  const run = await addRun(id, 'update', 'failed');
  await runFinished(id, 'update', run, 'failed');
  const [n] = await openOf(id);
  assert.equal(n.kind, 'run:update');
  assert.equal(n.run_id, run);
  assert.equal(n.message, `Bijwerken mislukt (run #${run})`);
  assert.ok((await page('/meldingen')).includes(`href="/sites/${id}/runs/${run}">Bekijk run`));

  // Another action's success leaves it alone.
  await runFinished(id, 'deploy', await addRun(id, 'deploy', 'success'), 'success');
  assert.equal((await openOf(id)).length, 1);
  await runFinished(id, 'update', await addRun(id, 'update', 'success'), 'success');
  assert.deepEqual(await openOf(id), []);

  const cut = await addRun(id, 'live', 'interrupted');
  await runFinished(id, 'live', cut, 'interrupted');
  assert.equal((await openOf(id))[0].message, `Live gaan onderbroken (run #${cut})`);
});

test('needs_confirmation creates no notification', async () => {
  const id = await addSite();
  await runFinished(id, 'live', await addRun(id, 'live', 'needs_confirmation'), 'needs_confirmation');
  assert.deepEqual(await notifications(id), []);
});

test('markInterruptedRuns flips running runs and notifies', async () => {
  const id = await addSite();
  const run = await addRun(id, 'deploy', 'running');
  await markInterruptedRuns();
  const { rows: [r] } = await db.query('SELECT status, finished_at FROM runs WHERE id = $1', [run]);
  assert.equal(r.status, 'interrupted');
  assert.ok(r.finished_at);
  const [n] = await openOf(id);
  assert.equal(n.kind, 'run:deploy');
  assert.equal(n.run_id, run);
});

test('repeated failed runs keep one open notification linking the newest run', async () => {
  const id = await addSite();
  await runFinished(id, 'update', await addRun(id, 'update', 'failed'), 'failed');
  const newest = await addRun(id, 'update', 'failed');
  await runFinished(id, 'update', newest, 'failed');
  const rows = await openOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, newest);
  assert.equal((await notifications(id)).length, 1);
});

test('after dismissing a run failure a new failed run notifies again, linking that run', async () => {
  const id = await addSite();
  await runFinished(id, 'update', await addRun(id, 'update', 'failed'), 'failed');
  const [first] = await notifications(id);
  await post(`/meldingen/${first.id}/afvinken`);
  assert.equal(await openCount(), 0);
  const newest = await addRun(id, 'update', 'interrupted');
  await runFinished(id, 'update', newest, 'interrupted');
  const rows = await openOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].run_id, newest);
  assert.ok((await notifications(id)).find((n) => n.id === first.id).resolved_at);
});

// The runner's own ending of a run, through the route and the fixture's tools/live.sh.
async function finishedLiveRun(id) {
  const res = await post(`/sites/${id}/run/live`);
  assert.equal(res.status, 302);
  const runId = Number(res.headers.get('location').split('/').pop());
  for (;;) {
    const { status } = await (await fetch(`${base}/sites/${id}/runs/${runId}.json`, { headers: { cookie } })).json();
    if (status !== 'running' && !(await db.query('SELECT 1 FROM runs WHERE id = $1 AND finished_at IS NULL', [runId])).rowCount) {
      await sleep(50); // the notification follows the final status update
      return runId;
    }
    await sleep(20);
  }
}

test('the runner notifies on a failed run and resolves on success; needs confirmation stays silent', async () => {
  const id = await addSite({ ssh: 'fail@host' });
  const failed = await finishedLiveRun(id);
  assert.equal((await openOf(id))[0].run_id, failed);
  await db.query(`UPDATE sites SET ssh_target = 'confirm@host' WHERE id = $1`, [id]);
  await finishedLiveRun(id);
  assert.equal((await openOf(id))[0].run_id, failed, 'needs confirmation changes nothing');
  await db.query(`UPDATE sites SET ssh_target = 'deploy@host' WHERE id = $1`, [id]);
  await finishedLiveRun(id);
  assert.deepEqual(await openOf(id), []);
});

test('retention: resolved rows are purged after 30 days; deleting a site removes its notifications', async () => {
  const id = await addSite();
  await runFinished(id, 'update', await addRun(id, 'update', 'failed'), 'failed');
  await db.query(`UPDATE notifications SET resolved_at = now() - interval '29 days'`);
  await purgeOld();
  assert.match(await page('/meldingen'), /Bijwerken mislukt/);
  await db.query(`UPDATE notifications SET resolved_at = now() - interval '31 days'`);
  assert.doesNotMatch(await page('/meldingen'), /Bijwerken mislukt/);
  await purgeOld();
  assert.deepEqual(await notifications(id), []);

  await runFinished(id, 'update', await addRun(id, 'update', 'failed'), 'failed');
  assert.equal((await post(`/sites/${id}/delete`)).status, 302);
  assert.equal((await db.query('SELECT 1 FROM notifications')).rows.length, 0);
});

test('newest first; the counter shows on every page and pages survive a failing count', async (t) => {
  const a = await addSite({ url: `${webUrl}/a`, title: 'Oudste' });
  const b = await addSite({ url: `${webUrl}/b`, title: 'Nieuwste' });
  await runFinished(a, 'update', await addRun(a, 'update', 'failed'), 'failed');
  await runFinished(b, 'update', await addRun(b, 'update', 'failed'), 'failed');
  await db.query(`UPDATE notifications SET created_at = created_at - interval '1 hour' WHERE site_id = $1`, [a]);
  const html = await page('/meldingen');
  assert.ok(html.indexOf('Nieuwste') < html.indexOf('Oudste'));
  for (const path of ['/', '/meldingen', '/ssh-key', '/instellingen', `/sites/${a}/runs`]) assert.equal(counter(await page(path)), 2, path);

  pool.query = async (sql, params) => {
    if (/count\(\*\) FROM notifications/.test(sql)) throw new Error('kapot');
    return query(sql, params);
  };
  t.after(() => { pool.query = query; });
  const res = await fetch(base, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(counter(await res.text()), 0);
});

test('the login page has no notifications link', async () => {
  const html = await (await fetch(`${base}/login`)).text();
  assert.doesNotMatch(html, /Meldingen/);
});
