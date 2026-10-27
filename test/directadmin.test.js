import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  testConnection, ensureKeyInstalled, keyBlob, findAuthorizedEntries, buildCustomizeParams, DA_MESSAGE,
  listDomains, listDatabases, createDatabase, freeDbSuffix, generateDbPassword,
} from '../src/directadmin.js';

const CUR = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICurrentCurrentCurrentCurrentCurrentCurr woutr-wp-dash';
const OLD = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOldOldOldOldOldOldOldOldOldOldOldOldOldOld woutr-wp-dash';
const FOREIGN = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABForeignForeignForeign someone@laptop';
const SECRET = 's3cr3t-p@ss';

// Fake DirectAdmin panel: state + request log.
let state, calls;
beforeEach(() => {
  calls = [];
  state = {
    reseller: { user: 'res', pass: SECRET, isReseller: true },
    users: {
      klant: {
        config: { username: 'klant', ssh: 'ON', package: 'basis', bandwidth: 'unlimited', quota: '1000', cgi: 'ON', php: 'OFF', git: 'ON', email_daily_limit: '250' },
        allowSsh: true,
        keys: {},
        domains: ['klant.nl', 'shop.klant.nl'],
        databases: ['klant_wp'],
      },
    },
  };
});

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let server, conn;
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const cmd = url.pathname.slice(1);
      const params = Object.fromEntries(req.method === 'GET' ? url.searchParams : new URLSearchParams(body));
      const [authUser, pass] = Buffer.from((req.headers.authorization ?? '').replace('Basic ', ''), 'base64').toString().split(':');
      const [login, as] = authUser.split('|');
      calls.push({ method: req.method, cmd, params, as });
      if (login !== state.reseller.user || pass !== state.reseller.pass) return send(res, 401, { error: '1', text: 'Unauthorized' });
      const u = state.users[as ?? params.user];
      if (cmd === 'CMD_API_SHOW_USERS') {
        if (!state.reseller.isReseller) return send(res, 200, { error: '1', text: 'You cannot execute that command' });
        return send(res, 200, { list: Object.keys(state.users) });
      }
      if (cmd === 'CMD_API_SHOW_DOMAINS') return send(res, 200, { list: u.domains });
      if (cmd === 'CMD_API_DATABASES' && req.method === 'GET') return send(res, 200, { list: u.databases });
      if (cmd === 'CMD_API_DATABASES' && params.action === 'create') return send(res, 200, { error: '1', text: 'Password rejected', details: `pw ${params.passwd} too weak` });
      if (cmd === 'CMD_API_SHOW_USER_CONFIG') return send(res, 200, u.config);
      if (cmd === 'CMD_API_MODIFY_USER') {
        if (u.allowSsh && params.ssh === 'ON') u.config.ssh = 'ON';
        return send(res, 200, { error: '0', text: 'Saved' });
      }
      if (cmd === 'CMD_SSH_KEYS') {
        if (req.method === 'GET') return send(res, 200, { authorized_keys: u.keys });
        if (params.action === 'authorize') {
          u.keys[`SHA256:fp${Object.keys(u.keys).length}`] = { key: params.text, comment: params.text.split(' ')[2] };
          return send(res, 200, { error: '0', text: 'Key added' });
        }
        if (params.action === 'delete') {
          delete u.keys[params.select0];
          return send(res, 200, { error: '0', text: 'Deleted' });
        }
      }
      send(res, 404, { error: '1', text: 'unknown command' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  conn = { url: `http://127.0.0.1:${server.address().port}`, username: 'res', password: SECRET };
});
after(() => server.close());

const posts = (action) => calls.filter((c) => c.method === 'POST' && c.params.action === action);

test('testConnection: success, wrong password, not a reseller, unreachable', async () => {
  assert.deepEqual(await testConnection(conn), { ok: true, message: 'Verbinding geslaagd: reseller-account met 1 gebruikers.' });
  const bad = await testConnection({ ...conn, password: 'wrong-pass' });
  assert.deepEqual(bad, { ok: false, message: DA_MESSAGE.auth });
  state.reseller.isReseller = false;
  const r = await testConnection(conn);
  assert.equal(r.ok, false);
  assert.ok(r.message.startsWith(DA_MESSAGE.not_reseller));
  const closed = createServer();
  await new Promise((res) => closed.listen(0, '127.0.0.1', res));
  const port = closed.address().port;
  await new Promise((res) => closed.close(res));
  const down = await testConnection({ ...conn, url: `http://127.0.0.1:${port}` });
  assert.deepEqual(down, { ok: false, message: DA_MESSAGE.unreachable });
  for (const m of [bad.message, r.message, down.message]) assert.ok(!m.includes(SECRET) && !m.includes('wrong-pass'));
});

test('ensureKeyInstalled adds the key once, labelled woutr-dash', async () => {
  assert.deepEqual(await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR }), { ok: true, removedOld: false });
  const add = posts('authorize');
  assert.equal(add.length, 1);
  assert.equal(add[0].as, 'klant');
  assert.equal(add[0].params.type, 'paste');
  assert.equal(add[0].params.text, `ssh-ed25519 ${keyBlob(CUR)} woutr-dash`);
  // Saving again / a second site on the same account: no second authorize.
  assert.deepEqual(await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR }), { ok: true, removedOld: false });
  assert.equal(posts('authorize').length, 1);
  assert.equal(Object.keys(state.users.klant.keys).length, 1);
});

test('SSH off but allowed: customize re-sends the whole config with ssh=ON', async () => {
  state.users.klant.config.ssh = 'OFF';
  assert.equal((await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR })).ok, true);
  const [mod] = calls.filter((c) => c.cmd === 'CMD_API_MODIFY_USER');
  assert.equal(mod.params.action, 'customize');
  assert.equal(mod.params.user, 'klant');
  assert.equal(mod.params.ssh, 'ON');
  assert.equal(mod.params.ubandwidth, 'ON');
  assert.equal(mod.params.quota, '1000');
  assert.equal(mod.params.cgi, 'ON');
  assert.equal(mod.params.git, 'ON');
  assert.equal(mod.params.email_daily_limit, '250');
  assert.ok(!('php' in mod.params));
  assert.ok(!('package' in mod.params));
  assert.equal(posts('authorize').length, 1);
});

test('SSH off and not allowed: fails with the Dutch reason, no key added', async () => {
  state.users.klant.config.ssh = 'OFF';
  state.users.klant.allowSsh = false;
  assert.deepEqual(await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR }), { ok: false, error: DA_MESSAGE.ssh_not_allowed });
  assert.equal(posts('authorize').length, 0);
});

test('unknown user: no_user, nothing else called', async () => {
  assert.deepEqual(await ensureKeyInstalled(conn, { user: 'onbekend', publicKey: CUR }), { ok: false, error: DA_MESSAGE.no_user });
  assert.deepEqual(calls.map((c) => c.cmd), ['CMD_API_SHOW_USERS']);
});

test('wrong password during install: auth message, no crash', async () => {
  const r = await ensureKeyInstalled({ ...conn, password: 'nope' }, { user: 'klant', publicKey: CUR });
  assert.deepEqual(r, { ok: false, error: DA_MESSAGE.auth });
});

test('rotation: removes only the previous dashboard key, keeps foreign keys', async () => {
  state.users.klant.keys = {
    'SHA256:foreign': { key: FOREIGN },
    'SHA256:old': { key: OLD.replace('woutr-wp-dash', 'other-comment') },
  };
  const r = await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR, retiredKeys: [OLD] });
  assert.deepEqual(r, { ok: true, removedOld: true });
  const del = posts('delete');
  assert.equal(del.length, 1);
  assert.equal(del[0].params.select0, 'SHA256:old');
  assert.equal(del[0].params.type, 'authorized_keys');
  const left = findAuthorizedEntries({ authorized_keys: state.users.klant.keys }).map((e) => e.blob);
  assert.deepEqual(left.sort(), [keyBlob(FOREIGN), keyBlob(CUR)].sort());
});

test('rotation: the same old key listed twice is deleted once', async () => {
  // The fake keys entries by fingerprint, so serve this listing directly: two lines, one fingerprint.
  const listing = [{ fingerprint: 'SHA256:old', key: OLD }, { fingerprint: 'SHA256:old', key: OLD }];
  const orig = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).includes('CMD_SSH_KEYS') && (opts?.method ?? 'GET') === 'GET'
    ? Promise.resolve(new Response(JSON.stringify({ authorized_keys: listing }), { headers: { 'content-type': 'application/json' } }))
    : orig(url, opts));
  try {
    const r = await ensureKeyInstalled(conn, { user: 'klant', publicKey: CUR, retiredKeys: [OLD] });
    assert.deepEqual(r, { ok: true, removedOld: true });
    assert.equal(posts('delete').length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test('keyBlob', () => {
  assert.equal(keyBlob(CUR), CUR.split(' ')[1]);
  assert.equal(keyBlob('from="1.2.3.4" ' + FOREIGN), FOREIGN.split(' ')[1]);
  assert.equal(keyBlob('garbage'), null);
  assert.equal(keyBlob(undefined), null);
});

test('findAuthorizedEntries: object- and array-shaped listings', () => {
  assert.deepEqual(findAuthorizedEntries({ authorized_keys: { 'SHA256:a': { key: CUR }, 'SHA256:b': FOREIGN } }), [
    { fingerprint: 'SHA256:a', text: CUR, blob: keyBlob(CUR) },
    { fingerprint: 'SHA256:b', text: FOREIGN, blob: keyBlob(FOREIGN) },
  ]);
  assert.deepEqual(findAuthorizedEntries({ authorized_keys: [{ fingerprint: 'SHA256:c', type: 'ssh-ed25519', key: keyBlob(OLD) }] }), [
    { fingerprint: 'SHA256:c', text: `ssh-ed25519 ${keyBlob(OLD)}`, blob: keyBlob(OLD) },
  ]);
  assert.deepEqual(findAuthorizedEntries({}), []);
  assert.deepEqual(findAuthorizedEntries({ authorized_keys: { x: { comment: 'no key' } } }), []);
});

test('buildCustomizeParams: deny-list, ON/unlimited/number rules, pass-through', () => {
  const p = buildCustomizeParams({
    username: 'klant', usertype: 'user', creator: 'res', package: 'basis', ip: '1.2.3.4', domain: 'x.nl', email: 'a@x.nl',
    ssh: 'OFF', cgi: 'ON', php: 'OFF', redis: 'ON', inode: 'unlimited', quota: '1000', nemails: '25.5',
    ns1: 'ns1.x.nl', ns2: 'ns2.x.nl', language: 'nl', skin: 'evolution', suspended: 'no',
  });
  assert.deepEqual(p, {
    cgi: 'ON', redis: 'ON', uinode: 'ON', quota: '1000', nemails: '25.5',
    ns1: 'ns1.x.nl', ns2: 'ns2.x.nl', language: 'nl', skin: 'evolution',
    ssh: 'ON', action: 'customize', user: 'klant',
  });
});

test('freeDbSuffix: slug-based, skips taken names, null when all are taken', () => {
  assert.equal(freeDbSuffix([], 'acct', 'innerhaven-bricks'), 'innerhavenbr');
  assert.equal(freeDbSuffix(['acct_vensa', 'acct_vensa2'], 'acct', 'vensa'), 'vensa3');
  assert.equal(freeDbSuffix(['other_vensa'], 'acct', 'vensa'), 'vensa');
  assert.equal(freeDbSuffix([], 'acct', '._-'), 'wp');
  const all = ['', 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `acct_vensa${i}`);
  assert.equal(freeDbSuffix(all, 'acct', 'vensa'), null);
});

test('generateDbPassword: 24 chars with lower, upper and digit', () => {
  for (let i = 0; i < 50; i++) {
    const p = generateDbPassword();
    assert.match(p, /^[A-Za-z0-9]{24}$/);
    assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p));
  }
});

test('listDomains / listDatabases log in as the account', async () => {
  assert.deepEqual(await listDomains(conn, 'klant'), ['klant.nl', 'shop.klant.nl']);
  assert.deepEqual(await listDatabases(conn, 'klant'), ['klant_wp']);
  assert.deepEqual(calls.map((c) => [c.cmd, c.as]), [['CMD_API_SHOW_DOMAINS', 'klant'], ['CMD_API_DATABASES', 'klant']]);
});

test('createDatabase posts the create params and scrubs the password from a refusal', async () => {
  const password = 'Gen3ratedPassw0rdXyzAbc1';
  await assert.rejects(createDatabase(conn, 'klant', { suffix: 'vensa', password }), (e) => {
    assert.equal(e.message, `${DA_MESSAGE.db_denied} (Password rejected: pw *** too weak)`);
    assert.ok(!e.message.includes(password) && !e.detail.includes(password));
    return true;
  });
  const [c] = calls;
  assert.equal(c.as, 'klant');
  assert.deepEqual({ ...c.params, json: undefined }, { action: 'create', name: 'vensa', user: 'vensa', passwd: password, passwd2: password, json: undefined });
});
