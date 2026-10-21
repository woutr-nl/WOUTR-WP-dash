import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const VALID = {
  ADMIN_USER: 'admin-value-xyz',
  ADMIN_PASSWORD: 'pass-value-xyz',
  SESSION_SECRET: 'session-secret-value-xyz-0123456789abcdef',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  POSTGRES_PASSWORD: 'pg-value-xyz',
  SSH_PRIVATE_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nssh-value-xyz\n-----END OPENSSH PRIVATE KEY-----',
  GITHUB_TOKEN: 'gh-value-xyz',
  BRICKS_LICENSE_KEY: 'bricks-value-xyz',
};

function start(env) {
  const { PATH, HOME } = process.env;
  return spawnSync(process.execPath, ['src/server.js'], { env: { PATH, HOME, ...env }, encoding: 'utf8', timeout: 10_000 });
}

function assertNoValues(output) {
  for (const value of Object.values(VALID)) assert.ok(!output.includes(value), 'output leaks a value');
}

for (const name of Object.keys(VALID)) {
  test(`missing ${name} stops startup and names it`, () => {
    const env = { ...VALID };
    delete env[name];
    const r = start(env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`omgevingsvariabele: ${name}\\b`));
    assertNoValues(r.stdout + r.stderr);
  });
}

test('invalid ENCRYPTION_KEY and short SESSION_SECRET are rejected by name', () => {
  for (const [name, value] of [['ENCRYPTION_KEY', 'te-kort'], ['SESSION_SECRET', 'kort']]) {
    const r = start({ ...VALID, [name]: value });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`omgevingsvariabele: ${name}\\b`));
    assert.ok(!r.stderr.includes(value));
  }
});
