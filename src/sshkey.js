// The dashboard's single SSH key: generated or adopted once, stored encrypted in
// `ssh_keys`, written to ~/.ssh/id for ssh. Never logged, rendered or put in an env.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import config from './config.js';
import { pool } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const run = promisify(execFile);
const ID_FILE = `${homedir()}/.ssh/id`;

let activeKey = null; // plaintext, only for log scrubbing

export function normalizeKey(raw) {
  let key = raw;
  if (key.includes('\\n') && !key.includes('\n')) key = key.replaceAll('\\n', '\n');
  if (!key.endsWith('\n')) key += '\n';
  return key;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'sshkey-')); // mkdtemp creates it 0700
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function describe(pubFile) {
  const publicKey = (await readFile(pubFile, 'utf8')).trim();
  const { stdout } = await run('ssh-keygen', ['-lf', pubFile]);
  const fingerprint = stdout.split(/\s+/).find((t) => t.startsWith('SHA256:'));
  if (!fingerprint) throw new Error('geen vingerafdruk');
  return { publicKey, fingerprint, keyType: publicKey.split(' ')[0] };
}

export const generateKeyPair = () => withTempDir(async (dir) => {
  const file = join(dir, 'id');
  await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'woutr-wp-dash', '-f', file]);
  return { privateKey: await readFile(file, 'utf8'), ...await describe(`${file}.pub`) };
});

export const inspectPrivateKey = (privateKey) => withTempDir(async (dir) => {
  const file = join(dir, 'id');
  await writeFile(file, normalizeKey(privateKey), { mode: 0o600 });
  // -P '': never prompt; a passphrase-protected key fails like an unparsable one.
  const { stdout } = await run('ssh-keygen', ['-y', '-P', '', '-f', file]);
  await writeFile(`${file}.pub`, stdout);
  return describe(`${file}.pub`);
});

async function activate(privateKey) {
  await writeFile(ID_FILE, privateKey, { mode: 0o600 });
  activeKey = privateKey;
}

function startupError(msg) {
  const e = new Error(msg);
  e.startup = true;
  return e;
}

export async function initSshKey() {
  const { rows: [row] } = await pool.query('SELECT private_key_enc FROM ssh_keys WHERE private_key_enc IS NOT NULL');
  if (row) {
    let key;
    try {
      key = decrypt(row.private_key_enc, config.encryptionKey);
    } catch {
      throw startupError('De opgeslagen SSH-sleutel kan niet worden ontsleuteld — klopt ENCRYPTION_KEY?');
    }
    return activate(key);
  }
  let key, info, adopted = false;
  if (config.sshPrivateKey) {
    key = normalizeKey(config.sshPrivateKey);
    try {
      info = await inspectPrivateKey(key);
    } catch {
      throw startupError('SSH_PRIVATE_KEY is geen geldige OpenSSH-sleutel (zonder wachtwoord).');
    }
    adopted = true;
  } else {
    ({ privateKey: key, ...info } = await generateKeyPair());
  }
  await pool.query(`INSERT INTO ssh_keys (private_key_enc, public_key, fingerprint, key_type, adopted)
    VALUES ($1, $2, $3, $4, $5)`, [encrypt(key, config.encryptionKey), info.publicKey, info.fingerprint, info.keyType, adopted]);
  await activate(key);
}

export async function getActiveKeyInfo() {
  const { rows } = await pool.query(`SELECT public_key, fingerprint, key_type, adopted, created_at, retired_at,
      private_key_enc IS NOT NULL AS active FROM ssh_keys ORDER BY id DESC`);
  const active = rows.find((r) => r.active) ?? null;
  return { ...active, retired: rows.filter((r) => !r.active) };
}

export const getActivePrivateKey = () => activeKey;

// Caller must make sure no run is active: ~/.ssh/id is rewritten.
export async function rotateKey() {
  const { privateKey, publicKey, fingerprint, keyType } = await generateKeyPair();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ssh_keys SET private_key_enc = NULL, retired_at = now() WHERE private_key_enc IS NOT NULL');
    await client.query(`INSERT INTO ssh_keys (private_key_enc, public_key, fingerprint, key_type)
      VALUES ($1, $2, $3, $4)`, [encrypt(privateKey, config.encryptionKey), publicKey, fingerprint, keyType]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await activate(privateKey);
  return { public_key: publicKey, fingerprint, key_type: keyType };
}
