import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import express from 'express';
import cookieSession from 'cookie-session';
import config from './config.js';
import { pool } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { validateSite } from './validate.js';

const root = new URL('..', import.meta.url).pathname;

// Columns safe to show; secrets are only exposed as has_* booleans.
const PUBLIC_COLUMNS = `id, client_slug, theme_type, ssh_target, wp_path, site_url, site_title,
  admin_email, admin_user, db_name, db_user, db_host, smtp_host, smtp_port, smtp_encryption,
  smtp_user, smtp_from, smtp_from_name,
  db_pass_enc IS NOT NULL AS has_db_pass, smtp_pass_enc IS NOT NULL AS has_smtp_pass`;
const SECRETS = { db_pass: 'db_pass_enc', smtp_pass: 'smtp_pass_enc' };
const PLAIN = ['client_slug', 'theme_type', 'ssh_target', 'wp_path', 'site_url', 'site_title',
  'admin_email', 'admin_user', 'db_name', 'db_user', 'db_host', 'smtp_host', 'smtp_port',
  'smtp_encryption', 'smtp_user', 'smtp_from', 'smtp_from_name'];

const sha = (s) => createHash('sha256').update(String(s ?? '')).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b));

// ponytail: in-memory, single instance — move to the DB if the app ever runs replicated.
const failures = new Map(); // ip -> { count, first, blockedUntil }
const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export function createApp() {
  const app = express();
  // Rollout's proxy is the one trusted hop: req.ip / req.secure come from its X-Forwarded-* headers.
  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', root + 'views');
  app.disable('x-powered-by');

  app.use('/public', express.static(root + 'public'));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieSession({
    name: 'session',
    keys: [config.sessionSecret],
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000,
  }));
  app.use((req, res, next) => {
    req.sessionOptions.secure = req.secure;
    res.set('Cache-Control', 'no-store');
    next();
  });

  const render = (res, view, locals = {}, status = 200) => {
    res.app.render(view, locals, (err, body) => {
      if (err) return res.req.next(err);
      res.status(status).render('layout', { ...locals, body, loggedIn: !!res.req.session?.user });
    });
  };

  app.get('/login', (req, res) => render(res, 'login', { title: 'Inloggen', error: null, username: '' }));

  app.post('/login', async (req, res) => {
    const now = Date.now();
    const ip = req.ip;
    const entry = failures.get(ip);
    if (entry?.blockedUntil > now) {
      return render(res, 'login', { title: 'Inloggen', error: 'Te veel mislukte pogingen, probeer het later opnieuw.', username: '' }, 429);
    }
    const { username = '', password = '' } = req.body ?? {};
    const okUser = same(username, config.adminUser);
    const okPass = same(password, config.adminPassword);
    if (okUser && okPass) {
      failures.delete(ip);
      req.session = { user: config.adminUser };
      return res.redirect('/');
    }
    for (const [k, v] of failures) if (now - v.first > WINDOW && !(v.blockedUntil > now)) failures.delete(k);
    const f = failures.get(ip) ?? { count: 0, first: now, blockedUntil: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILURES) f.blockedUntil = now + WINDOW;
    failures.set(ip, f);
    await sleep(500);
    render(res, 'login', { title: 'Inloggen', error: 'Onjuiste gebruikersnaam of wachtwoord.', username: String(username) }, 401);
  });

  app.use((req, res, next) => (req.session?.user ? next() : res.redirect('/login')));

  app.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login');
  });

  app.get('/', async (req, res) => {
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM sites ORDER BY site_title, id`);
    render(res, 'sites', { title: 'Sites', sites: rows });
  });

  const formLocals = (site, errors = {}) => ({
    title: site.id ? `${site.site_title} bewerken` : 'Site toevoegen', site, errors,
  });
  const emptySite = { theme_type: 'block', admin_user: 'beheer', db_host: 'localhost' };

  async function loadSite(id) {
    if (!/^\d+$/.test(id)) return null;
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM sites WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  async function save(req, res, existing) {
    const { values, errors } = validateSite(req.body ?? {});
    // Re-render with what was entered (never the secrets).
    const redisplay = () => render(res, 'site-form', formLocals({
      ...(existing ?? emptySite), ...pick(req.body ?? {}, PLAIN), id: existing?.id,
    }, errors), 422);
    if (Object.keys(errors).length) return redisplay();

    const cols = [...PLAIN];
    const params = PLAIN.map((c) => values[c]);
    for (const [field, column] of Object.entries(SECRETS)) {
      if (values[field] === undefined) continue; // keep stored value
      cols.push(column);
      params.push(values[field] === null ? null : encrypt(values[field], config.encryptionKey));
    }
    try {
      if (existing) {
        const set = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
        await pool.query(`UPDATE sites SET ${set}, updated_at = now() WHERE id = $${cols.length + 1}`, [...params, existing.id]);
      } else {
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await pool.query(`INSERT INTO sites (${cols.join(', ')}) VALUES (${ph})`, params);
      }
    } catch (e) {
      if (e.code !== '23505') throw e;
      errors.site_url = 'Er bestaat al een site met deze URL.';
      return redisplay();
    }
    res.redirect('/');
  }

  app.get('/sites/new', (req, res) => render(res, 'site-form', formLocals(emptySite)));
  app.post('/sites', (req, res) => save(req, res, null));

  app.get('/sites/:id/edit', async (req, res) => {
    const site = await loadSite(req.params.id);
    if (!site) return notFound(res);
    render(res, 'site-form', formLocals(site));
  });

  app.post('/sites/:id', async (req, res) => {
    const site = await loadSite(req.params.id);
    if (!site) return notFound(res);
    await save(req, res, site);
  });

  app.post('/sites/:id/delete', async (req, res) => {
    if (/^\d+$/.test(req.params.id)) await pool.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
    res.redirect('/');
  });

  app.post('/sites/:id/reveal/:field', async (req, res) => {
    const column = Object.hasOwn(SECRETS, req.params.field) && SECRETS[req.params.field];
    if (!column || !/^\d+$/.test(req.params.id)) return res.status(404).json({ error: 'Niet gevonden.' });
    const { rows } = await pool.query(`SELECT ${column} AS enc FROM sites WHERE id = $1`, [req.params.id]);
    if (!rows[0]?.enc) return res.status(404).json({ error: 'Niet gevonden.' });
    try {
      res.json({ value: decrypt(rows[0].enc, config.encryptionKey) });
    } catch {
      res.status(500).json({ error: 'Kan niet ontsleutelen — klopt ENCRYPTION_KEY?' });
    }
  });

  const notFound = (res) => res.status(404).type('text').send('Niet gevonden.');
  app.use((req, res) => notFound(res));

  // Log the message only: never request bodies (they may hold secrets).
  app.use((err, req, res, next) => {
    console.error(`Fout bij ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(500).type('text').send('Er ging iets mis.');
  });

  return app;
}

function pick(obj, keys) {
  return Object.fromEntries(keys.filter((k) => typeof obj[k] === 'string').map((k) => [k, obj[k]]));
}
