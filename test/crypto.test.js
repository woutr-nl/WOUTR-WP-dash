import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, parseKey } from '../src/crypto.js';

const key = parseKey(randomBytes(32).toString('base64'));

test('roundtrip', () => {
  const enc = encrypt('géheim-wachtwoord', key);
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes('géheim'));
  assert.equal(decrypt(enc, key), 'géheim-wachtwoord');
});

test('unique IVs', () => {
  assert.notEqual(encrypt('x', key), encrypt('x', key));
});

test('tamper throws', () => {
  const raw = Buffer.from(encrypt('secret', key).slice(3), 'base64');
  raw[raw.length - 20] ^= 1;
  assert.throws(() => decrypt('v1:' + raw.toString('base64'), key));
});

test('wrong key throws', () => {
  const other = parseKey(randomBytes(32).toString('base64'));
  assert.throws(() => decrypt(encrypt('secret', key), other));
});

test('wrong-length key rejected', () => {
  assert.throws(() => parseKey(randomBytes(16).toString('base64')));
  assert.throws(() => parseKey('niet-base64'));
});
