// The real dashboard app for e2e/plugin-update.sh, with only GitHub faked: one plugin release whose
// asset is the zip in $E2E_DIR/woutr-plugin.zip and whose main file is $E2E_DIR/woutr-plugin.php.
// The database is PGlite, as in the unit tests; the update routes don't use it. Every GitHub call
// is logged as one JSON line, for the script to check.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dir = process.env.E2E_DIR;
const TOKEN = 'ghp_e2e_token';
const home = mkdtempSync(join(tmpdir(), 'dash-e2e-'));
mkdirSync(join(home, '.ssh'));
Object.assign(process.env, {
  HOME: home, ADMIN_USER: 'admin', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'), POSTGRES_PASSWORD: 'c', GITHUB_TOKEN: TOKEN, BRICKS_LICENSE_KEY: 'e',
});
const { pool, initDb } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');

const db = new PGlite();
const query = async (sql, params) => (params ? db.query(sql, params) : { rows: [], rowCount: 0, ...(await db.exec(sql)).at(-1) });
pool.query = query;
pool.connect = async () => ({ query, release() {} });
await initDb();

const API = 'https://api.github.com/repos/woutr-nl/WOUTR-WP';
const php = readFileSync(join(dir, 'woutr-plugin.php'));
const zip = readFileSync(join(dir, 'woutr-plugin.zip'));
const version = php.toString().match(/^\s*\*\s*Version:\s*(\S+)/m)[1];
const tag = `woutr-plugin-v${version}`;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = new URL(String(url));
  if (u.hostname !== 'api.github.com') return realFetch(url, opts);
  console.log(JSON.stringify({ github: String(url), accept: opts.headers.Accept, auth: opts.headers.Authorization === `Bearer ${TOKEN}` }));
  if (u.pathname === '/repos/woutr-nl/WOUTR-WP/releases') {
    return Response.json([{ tag_name: tag, draft: false, prerelease: false, assets: [{ name: 'woutr-plugin.zip', size: zip.length, url: `${API}/releases/assets/1` }] }]);
  }
  if (u.pathname === '/repos/woutr-nl/WOUTR-WP/releases/assets/1') return new Response(zip);
  if (u.pathname === '/repos/woutr-nl/WOUTR-WP/contents/plugin/woutr-plugin.php' && u.searchParams.get('ref') === tag) return new Response(php);
  return new Response('{}', { status: 404 });
};

const port = Number(process.env.PORT ?? 8080);
createApp().listen(port, () => console.log(`dashboard e2e luistert op poort ${port} (release ${tag})`));
