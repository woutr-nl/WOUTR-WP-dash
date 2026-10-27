// Reads and validates every environment variable at import. On a missing or
// invalid value it prints the variable NAME only (never a value) and exits.
import { parseKey } from './crypto.js';

const env = process.env;

function fail(name) {
  console.error(`Ontbrekende of ongeldige omgevingsvariabele: ${name}`);
  process.exit(1);
}

function required(name, check = () => true) {
  const value = env[name];
  if (!value || !value.trim() || !check(value)) fail(name);
  return value;
}

function encryptionKey() {
  required('ENCRYPTION_KEY');
  try {
    return parseKey(env.ENCRYPTION_KEY);
  } catch {
    fail('ENCRYPTION_KEY');
  }
}

const port = env.PORT ? Number(env.PORT) : 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT');

const config = {
  adminUser: required('ADMIN_USER'),
  adminPassword: required('ADMIN_PASSWORD'),
  sessionSecret: required('SESSION_SECRET', (v) => v.length >= 32),
  encryptionKey: encryptionKey(),
  postgresPassword: required('POSTGRES_PASSWORD'),
  // Optional: only adopted once when no key is stored yet (see sshkey.js).
  sshPrivateKey: env.SSH_PRIVATE_KEY?.trim() ? env.SSH_PRIVATE_KEY : null,
  githubToken: required('GITHUB_TOKEN'),
  bricksLicenseKey: required('BRICKS_LICENSE_KEY'),
  port,
  pg: {
    host: env.PGHOST || 'db',
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    user: env.PGUSER || 'woutrdash',
    database: env.PGDATABASE || 'woutrdash',
  },
};

export default config;
