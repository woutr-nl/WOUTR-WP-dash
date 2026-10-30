// Hourly HTTP-only health check of deployed sites: no SSH, no run lock, no runs rows.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { pool } from './db.js';
import { notify, resolve, purgeOld } from './notifications.js';

export const HOUR = 3600_000;
const TIMEOUT = 10_000;
const MAX_REDIRECTS = 5;
const BODY_CAP = 512 * 1024;
const CERT_WARN_MS = 14 * 24 * HOUR;
const FAILS_TO_NOTIFY = 2;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// ponytail: in-memory, single instance — same ceiling as sslBusy.
const busy = new Set(); // siteId: one check per site at a time (sweep vs. Nu controleren)
// ponytail: mutable object purely so tests can feed chosen certificate facts.
export const probes = { tls: probeTls };

export function initHealth() {
  const run = () => sweep().catch((e) => console.error(`Gezondheidscontrole mislukt: ${e.message}`));
  run();
  setInterval(run, HOUR).unref();
}

// All deployed sites in parallel: each has its own timeouts, so a slow site delays nobody.
export async function sweep() {
  const { rows } = await pool.query(`SELECT id, site_url FROM sites s
    WHERE EXISTS (SELECT 1 FROM runs WHERE site_id = s.id AND action = 'deploy' AND status = 'success')`);
  await Promise.allSettled(rows.map(async (site) => {
    try {
      await checkSite(site);
    } catch (e) {
      if (!e.busy) console.error(`Gezondheidscontrole van site ${site.id} mislukt: ${e.message}`);
    }
  }));
  await purgeOld();
}

// Runs the checks, stores the result and notifies/resolves. Returns the stored health object.
export async function checkSite(site) {
  if (busy.has(site.id)) throw Object.assign(new Error('Er loopt al een controle voor deze site.'), { busy: true });
  busy.add(site.id);
  try {
    // Live = at least one successful go-live run, so a later failed live run doesn't silence the check.
    const { rows: [state] } = await pool.query(`SELECT health,
      EXISTS (SELECT 1 FROM runs WHERE site_id = s.id AND action = 'live' AND status = 'success') AS live
      FROM sites s WHERE id = $1`, [site.id]);
    const response = await fetchInsecure(site.site_url).catch((e) => ({ error: describeError(e) }));
    const results = {
      reachable: checkReachable(response),
      cert: await checkCert(site.site_url),
      noindex: checkNoindex(response, state?.live),
    };

    const checks = {};
    for (const [name, result] of Object.entries(results)) {
      checks[name] = { ...result, fails: await applyResult(site.id, name, result, state?.health?.checks?.[name]?.fails ?? 0) };
    }
    const statuses = Object.values(checks).map((c) => c.status);
    const status = statuses.includes('failed') ? 'problem' : statuses.includes('warning') ? 'warning' : 'ok';
    const health = { status, checked_at: new Date().toISOString(), checks };
    await pool.query('UPDATE sites SET health = $2 WHERE id = $1', [site.id, health]);
    return health;
  } finally {
    busy.delete(site.id);
  }
}

const MESSAGE = {
  reachable: (r) => `Site niet bereikbaar (${r.detail})`,
  cert: (r) => (r.status === 'warning' ? `SSL-certificaat ${r.detail}` : `SSL-certificaat ongeldig of verlopen (${r.detail})`),
  noindex: () => 'Zoekmachines worden geweerd (noindex) op een live site',
};

// Notifies or resolves for one check; returns its new consecutive-failure streak.
async function applyResult(siteId, name, result, prevFails) {
  const kind = `health:${name}`;
  if (result.status === 'skipped') return prevFails;
  if (result.status === 'failed') {
    const fails = prevFails + 1;
    if (fails >= FAILS_TO_NOTIFY) await notify(siteId, kind, 'problem', MESSAGE[name](result));
    return fails;
  }
  if (result.status === 'warning') await notify(siteId, kind, 'warning', MESSAGE[name](result));
  else await resolve(siteId, kind);
  return 0;
}

function checkReachable(response) {
  if (response.error) return { status: 'failed', detail: response.error };
  return response.status >= 200 && response.status < 400 ? { status: 'ok' } : { status: 'failed', detail: `HTTP ${response.status}` };
}

async function checkCert(siteUrl) {
  const url = new URL(siteUrl);
  if (url.protocol !== 'https:') return { status: 'skipped', detail: 'geen HTTPS' };
  return classifyCert(await probes.tls(url.hostname, Number(url.port) || 443));
}

function checkNoindex(response, live) {
  if (!live) return { status: 'skipped', detail: 'site is niet live' };
  if (checkReachable(response).status !== 'ok') return { status: 'skipped', detail: 'site niet bereikbaar' };
  if (/noindex/i.test(response.headers['x-robots-tag'] ?? '')) return { status: 'failed', detail: 'noindex in X-Robots-Tag-header' };
  // Two steps on purpose: the body is untrusted, and one regex spanning both would backtrack for minutes on the event loop.
  const metas = response.body.match(/<meta\b[^<>]*>/gi) ?? [];
  return metas.some((m) => /name=["']?robots["']?/i.test(m) && /noindex/i.test(m)) ? { status: 'failed', detail: 'noindex in robots-metatag' } : { status: 'ok' };
}

const fmtDay = (d) => d.toLocaleDateString('nl-NL', { timeZone: 'Europe/Amsterdam' });

// Maps the raw facts of probeTls to a check result.
export function classifyCert(facts, now = new Date()) {
  if (!facts.ok) return { status: 'failed', detail: `kon certificaat niet controleren: ${facts.error}` };
  const expires = facts.validTo ? new Date(facts.validTo) : null;
  const expires_at = expires?.toISOString();
  if (!expires) return { status: 'failed', detail: 'geen certificaat ontvangen' };
  if (expires <= now) return { status: 'failed', detail: `verlopen op ${fmtDay(expires)}`, expires_at };
  if (!facts.authorized) return { status: 'failed', detail: `ongeldig: ${facts.authorizationError}`, expires_at };
  if (facts.hostError) return { status: 'failed', detail: `niet geldig voor deze host: ${facts.hostError}`, expires_at };
  if (expires - now <= CERT_WARN_MS) return { status: 'warning', detail: `verloopt op ${fmtDay(expires)}`, expires_at };
  return { status: 'ok', detail: `geldig tot ${fmtDay(expires)}`, expires_at };
}

// Rejection off, so an expired or invalid chain still yields the peer certificate to classify.
export function probeTls(host, port) {
  return new Promise((done) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: TIMEOUT });
    const finish = (facts) => { socket.destroy(); done(facts); };
    socket.once('error', (e) => finish({ ok: false, error: describeError(e) }));
    socket.once('timeout', () => finish({ ok: false, error: 'time-out' }));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      finish({
        ok: true, authorized: socket.authorized, authorizationError: socket.authorizationError,
        hostError: cert.valid_to && tls.checkServerIdentity(host, cert)?.message, validTo: cert.valid_to,
      });
    });
  });
}

// Global fetch rejects on an invalid certificate before any HTTP status is seen, and
// certificate problems belong to the Certificaat check only. One deadline for all hops.
async function fetchInsecure(siteUrl) {
  const signal = AbortSignal.timeout(TIMEOUT);
  let url = new URL(siteUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await request(url, signal);
    const location = REDIRECTS.has(response.status) && response.headers.location;
    if (!location) return response;
    url = new URL(location, url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('doorverwijzing naar een niet-HTTP-adres');
  }
  throw new Error('te veel doorverwijzingen');
}

function request(url, signal) {
  return new Promise((done, fail) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      signal, agent: false, rejectUnauthorized: false, headers: { 'user-agent': 'WOUTR-WP-dash health check' },
    }, (res) => {
      const chunks = [];
      let size = 0;
      const finish = () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() });
      res.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= BODY_CAP) { finish(); res.destroy(); }
      });
      res.on('end', finish);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end();
  });
}

function describeError(e) {
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'time-out';
  if (e.code === 'ECONNREFUSED') return 'verbinding geweigerd';
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'domein niet gevonden';
  return e.message || e.code || 'onbekende fout';
}
