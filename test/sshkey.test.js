import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// sshkey.js imports config.js, which exits on missing env: set it before the dynamic import.
Object.assign(process.env, {
  ADMIN_USER: 'a', ADMIN_PASSWORD: 'b', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: 'd', BRICKS_LICENSE_KEY: 'e',
});
const { normalizeKey, generateKeyPair, inspectPrivateKey } = await import('../src/sshkey.js');
const { classifySshTest } = await import('../src/runs.js');

const tempDirs = () => readdirSync(tmpdir()).filter((f) => f.startsWith('sshkey-'));

test('generateKeyPair: ed25519 key, one-line public key, SHA256 fingerprint, temp dir removed', async () => {
  const before = tempDirs().length;
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  assert.match(a.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
  assert.match(a.publicKey, /^ssh-ed25519 \S+ woutr-wp-dash$/);
  assert.match(a.fingerprint, /^SHA256:\S+$/);
  assert.equal(a.keyType, 'ssh-ed25519');
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(tempDirs().length, before);
});

test('inspectPrivateKey reproduces public key and fingerprint, also from the literal-\\n form', async () => {
  const k = await generateKeyPair();
  const pub = k.publicKey.split(' ').slice(0, 2).join(' ');
  for (const input of [k.privateKey, k.privateKey.trimEnd().replaceAll('\n', '\\n')]) {
    const info = await inspectPrivateKey(normalizeKey(input));
    assert.equal(info.publicKey.split(' ').slice(0, 2).join(' '), pub);
    assert.equal(info.fingerprint, k.fingerprint);
    assert.equal(info.keyType, 'ssh-ed25519');
  }
  await assert.rejects(inspectPrivateKey('geen sleutel'));
});

test('normalizeKey', () => {
  assert.equal(normalizeKey('-----A-----\\nabc\\n-----B-----'), '-----A-----\nabc\n-----B-----\n');
  assert.equal(normalizeKey('-----A-----\nabc\n-----B-----'), '-----A-----\nabc\n-----B-----\n');
  assert.equal(normalizeKey('-----A-----\nabc\n-----B-----\n'), '-----A-----\nabc\n-----B-----\n');
});

test('classifySshTest', () => {
  assert.equal(classifySshTest(0, ''), 'ok');
  assert.equal(classifySshTest(255, 'deploy@acme.nl: Permission denied (publickey).\n'), 'denied');
  assert.equal(classifySshTest(255, '@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n'), 'hostkey');
  assert.equal(classifySshTest(255, 'Host key verification failed.\n'), 'hostkey');
  assert.equal(classifySshTest(255, 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\nPermission denied (publickey).\n'), 'hostkey');
  assert.equal(classifySshTest(255, 'ssh: connect to host x port 22: Connection timed out\n'), 'unreachable');
  assert.equal(classifySshTest(255, 'ssh: connect to host x port 22: Connection refused\n'), 'unreachable');
  assert.equal(classifySshTest(null, ''), 'unreachable');
});
