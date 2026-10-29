import { randomInt, X509Certificate } from 'node:crypto';

// DirectAdmin reseller client (legacy API, Basic auth, json=yes) and the per-account
// key installation. DB- and config-free: callers pass conn = { url, username, password }.
// The password only ever travels in the Authorization header, never in a URL or message.

export const DA_MESSAGE = {
  auth: 'Inloggegevens geweigerd door het DirectAdmin-paneel.',
  unreachable: 'Het DirectAdmin-paneel is niet bereikbaar.',
  not_reseller: 'Dit account kan geen gebruikers beheren; gebruik een reseller- of admin-account.',
  no_user: 'Hosting-account niet gevonden onder deze reseller.',
  ssh_not_allowed: 'SSH is niet toegestaan voor dit hosting-account (pakket of reseller staat het niet toe).',
  denied: 'DirectAdmin weigerde de opdracht.',
  db_denied: 'DirectAdmin weigerde de database aan te maken.',
  ssl_denied: 'DirectAdmin weigerde de certificaataanvraag.',
  ssl_no_right: 'De login key mist het recht CMD_API_SSL; voeg die opdracht toe aan de login key in DirectAdmin.',
  ssl_dns: 'Het domein wijst (nog) niet naar deze server (DNS). Richt de DNS en probeer het daarna opnieuw.',
  ssl_rate: 'De Let\'s Encrypt-limiet voor dit domein is bereikt; probeer het later opnieuw.',
  ssl_not_allowed: 'SSL is niet toegestaan voor dit hosting-account (pakket of reseller staat het niet toe).',
};

export const KEY_LABEL = 'woutr-dash';

class DaError extends Error {
  constructor(code, detail = '') {
    super(DA_MESSAGE[code] + (detail ? ` (${detail})` : ''));
    this.code = code;
    this.detail = detail;
  }
}

const isError = (v) => v !== undefined && v !== null && v !== '' && v !== '0' && v !== 0 && v !== false;

export async function daRequest(conn, cmd, { method = 'GET', params = {}, loginAs, timeout = 10_000 } = {}) {
  const user = loginAs ? `${conn.username}|${loginAs}` : conn.username;
  const auth = `Basic ${Buffer.from(`${user}:${conn.password}`).toString('base64')}`;
  const query = new URLSearchParams({ ...params, json: 'yes' });
  let url = `${conn.url}/${cmd}`;
  let body;
  if (method === 'GET') url += `?${query}`;
  else body = query; // fetch sends it as application/x-www-form-urlencoded
  let res, text;
  try {
    res = await fetch(url, { method, body, headers: { Authorization: auth }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch {
    throw new DaError('unreachable');
  }
  if (res.status === 401 || res.status === 403 || res.headers.get('x-directadmin') === 'unauthorized') throw new DaError('auth');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new DaError('unreachable', `onverwacht antwoord, HTTP ${res.status}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && isError(data.error)) {
    let detail = [data.text, data.details].filter((s) => typeof s === 'string' && s).join(': ').replace(/\s+/g, ' ').slice(0, 200);
    if (conn.password) detail = detail.replaceAll(conn.password, '***');
    throw new DaError('denied', detail);
  }
  return data;
}

// Dutch message for a failure; a 'denied' answer is mapped to deniedCode when given.
export function messageFor(e, deniedCode) {
  if (!(e instanceof DaError)) return DA_MESSAGE.unreachable;
  if (e.code === 'denied' && deniedCode) return new DaError(deniedCode, e.detail).message;
  return e.message;
}

function userList(data) {
  const list = Array.isArray(data) ? data : data?.list;
  return (Array.isArray(list) ? list : Object.values(list ?? {})).filter((u) => typeof u === 'string');
}

export const listUsers = async (conn) => userList(await daRequest(conn, 'CMD_API_SHOW_USERS'));
export const listDomains = async (conn, user) => userList(await daRequest(conn, 'CMD_API_SHOW_DOMAINS', { loginAs: user }));
// Full names, like 'acct_wp'.
export const listDatabases = async (conn, user) => userList(await daRequest(conn, 'CMD_API_DATABASES', { loginAs: user }));

// Creates database and user `<user>_<suffix>` with the given password. Throws DaError.
export async function createDatabase(conn, user, { suffix, password }) {
  try {
    await daRequest(conn, 'CMD_API_DATABASES', {
      method: 'POST', loginAs: user,
      params: { action: 'create', name: suffix, user: suffix, passwd: password, passwd2: password },
    });
  } catch (e) {
    if (!(e instanceof DaError)) throw e;
    // daRequest only scrubs the reseller secret; DirectAdmin may echo this password too.
    throw new DaError(e.code === 'denied' ? 'db_denied' : e.code, e.detail.replaceAll(password, '***'));
  }
  return { name: `${user}_${suffix}`, user: `${user}_${suffix}` };
}

// First suffix (slug-based, then 2…9) whose `<user>_<suffix>` is not taken; null when all are.
export const dbSuffixBase = (clientSlug) => String(clientSlug ?? '').replace(/[^a-z0-9]/g, '').slice(0, 12) || 'wp';

export function freeDbSuffix(existingNames, user, clientSlug) {
  const base = dbSuffixBase(clientSlug);
  for (const suffix of [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => `${base}${i}`)]) {
    if (!existingNames.includes(`${user}_${suffix}`)) return suffix;
  }
  return null;
}

const PASS_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function generateDbPassword() {
  for (;;) {
    const p = Array.from({ length: 24 }, () => PASS_CHARS[randomInt(PASS_CHARS.length)]).join('');
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

export async function testConnection(conn) {
  try {
    const users = await listUsers(conn);
    return { ok: true, message: `Verbinding geslaagd: reseller-account met ${users.length} gebruikers.` };
  } catch (e) {
    return { ok: false, message: messageFor(e, 'not_reseller') };
  }
}

// The base64 blob of a public-key line: identity is decided on this, never on comments.
export function keyBlob(publicKey) {
  if (typeof publicKey !== 'string') return null;
  return publicKey.trim().split(/\s+/).find((t) => /^AAAA[A-Za-z0-9+/]+=*$/.test(t)) ?? null;
}

// CMD_SSH_KEYS listing → [{ fingerprint, text, blob }]. Shape is thinly documented:
// accepts an object keyed by fingerprint or an array, with string or object entries.
export function findAuthorizedEntries(listing) {
  const raw = listing?.authorized_keys ?? {};
  const pairs = Array.isArray(raw) ? raw.map((v) => [null, v]) : Object.entries(raw);
  const out = [];
  for (const [name, v] of pairs) {
    let text, fingerprint = null;
    if (typeof v === 'string') text = v;
    else if (v && typeof v === 'object') {
      fingerprint = v.fingerprint ?? v.fingerprint_sha256 ?? null;
      text = [v.key, v.text, v.public_key, v.value].find((s) => typeof s === 'string' && keyBlob(s));
      if (text && !/\s/.test(text.trim()) && typeof v.type === 'string') text = `${v.type} ${text}`;
    }
    if (!fingerprint && name && !/^\d+$/.test(name)) fingerprint = name;
    const blob = keyBlob(text);
    if (blob) out.push({ fingerprint, text: text.trim(), blob });
  }
  return out;
}

// Not part of the customize form; everything else is round-tripped.
const CONFIG_META = new Set(['username', 'usertype', 'creator', 'package', 'account', 'date_created', 'date_modified',
  'suspended', 'ip', 'original_ip', 'domain', 'email', 'name', 'zoom', 'docsroot']);
const PASS_THROUGH = ['ns1', 'ns2', 'language', 'skin'];

// SHOW_USER_CONFIG → MODIFY_USER action=customize with flags forced (default ssh=ON). Generic
// read-modify-write: DirectAdmin turns absent checkboxes OFF and resets omitted limits, so every
// ON flag, unlimited limit and numeric limit is re-sent, including ones this code doesn't know.
// flags = {} is a pure round-trip of the given config.
export function buildCustomizeParams(userConfig, flags = { ssh: 'ON' }) {
  const p = {};
  for (const [k, v] of Object.entries(userConfig ?? {})) {
    if (CONFIG_META.has(k) || typeof v !== 'string') continue;
    if (v === 'ON') p[k] = 'ON';
    else if (v === 'unlimited') p[`u${k}`] = 'ON';
    else if (/^\d+(\.\d+)?$/.test(v)) p[k] = v;
  }
  for (const k of PASS_THROUGH) if (typeof userConfig?.[k] === 'string') p[k] = userConfig[k];
  return { ...p, ...flags, action: 'customize', user: userConfig?.username };
}

// Makes sure `user` has SSH on and our current key authorized; removes entries whose blob
// matches one of retiredKeys. Never touches other keys. Never throws.
export async function ensureKeyInstalled(conn, { user, publicKey, retiredKeys = [] }) {
  let deniedCode = 'not_reseller';
  try {
    if (!userList(await daRequest(conn, 'CMD_API_SHOW_USERS')).includes(user)) return { ok: false, error: DA_MESSAGE.no_user };
    deniedCode = null;
    let cfg = await daRequest(conn, 'CMD_API_SHOW_USER_CONFIG', { params: { user } });
    if (cfg?.ssh !== 'ON') {
      deniedCode = 'ssh_not_allowed';
      await daRequest(conn, 'CMD_API_MODIFY_USER', { method: 'POST', params: { ...buildCustomizeParams(cfg), user } });
      cfg = await daRequest(conn, 'CMD_API_SHOW_USER_CONFIG', { params: { user } });
      if (cfg?.ssh !== 'ON') return { ok: false, error: DA_MESSAGE.ssh_not_allowed };
      deniedCode = null;
    }

    const blob = keyBlob(publicKey);
    if (!blob) throw new Error('geen geldige publieke sleutel');
    const entries = findAuthorizedEntries(await daRequest(conn, 'CMD_SSH_KEYS', { loginAs: user }));
    if (!entries.some((e) => e.blob === blob)) {
      await daRequest(conn, 'CMD_SSH_KEYS', {
        method: 'POST', loginAs: user,
        params: { action: 'authorize', type: 'paste', text: `${publicKey.trim().split(/\s+/)[0]} ${blob} ${KEY_LABEL}` },
      });
    }

    const old = new Set(retiredKeys.map(keyBlob).filter((b) => b && b !== blob));
    const stale = entries.filter((x) => old.has(x.blob));
    if (stale.some((e) => !e.fingerprint)) return { ok: false, error: 'Vorige dashboardsleutel gevonden, maar DirectAdmin gaf geen vingerafdruk om hem te verwijderen.' };
    // One delete per fingerprint: the same key listed twice shares it, and a second delete may be refused.
    const fingerprints = new Set(stale.map((e) => e.fingerprint));
    for (const fingerprint of fingerprints) {
      await daRequest(conn, 'CMD_SSH_KEYS', {
        method: 'POST', loginAs: user, params: { action: 'delete', type: 'authorized_keys', select0: fingerprint },
      });
    }
    const removedOld = fingerprints.size > 0;
    return { ok: true, removedOld };
  } catch (e) {
    return { ok: false, error: messageFor(e, deniedCode) };
  }
}

// Dutch reason for a failed CMD_API_SSL call. Those run after SHOW_USER_CONFIG succeeded with
// the same key, so a login failure here means the login key lacks CMD_API_SSL.
export function classifySslFailure(e) {
  if (!(e instanceof DaError)) return DA_MESSAGE.unreachable;
  if (e.code === 'auth') return DA_MESSAGE.ssl_no_right;
  if (e.code !== 'denied') return e.message;
  if (/rate ?limit|too many (certificates|failed)/i.test(e.detail)) return DA_MESSAGE.ssl_rate;
  if (/DNS problem|NXDOMAIN|no valid A record|Timeout during connect|Connection refused|Invalid response/i.test(e.detail)) return DA_MESSAGE.ssl_dns;
  if (/cannot execute that command|not allowed/i.test(e.detail)) return DA_MESSAGE.ssl_no_right;
  return new DaError('ssl_denied', e.detail).message;
}

// The installed certificate's field name differs between DirectAdmin versions: scan the values.
export function extractCertificatePem(data) {
  for (const v of Object.values(data ?? {})) {
    const m = typeof v === 'string' && v.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (m) return m[0];
  }
  return null;
}

// { names, expiresAt, valid } of the certificate installed for domain, or null. Throws DaError.
export async function getCertificateInfo(conn, user, domain) {
  const pem = extractCertificatePem(await daRequest(conn, 'CMD_API_SSL', { loginAs: user, params: { domain } }));
  if (!pem) return null;
  let cert;
  try {
    cert = new X509Certificate(pem);
  } catch {
    return null;
  }
  const san = (cert.subjectAltName ?? '').split(', ').filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
  const names = san.length ? san : [cert.subject.match(/CN=([^\n,]+)/)?.[1]].filter(Boolean);
  const expires = new Date(cert.validTo);
  return { names, expiresAt: expires.toISOString(), valid: expires > new Date() && Boolean(cert.checkHost(domain)) };
}

const issueLetsEncrypt = (conn, user, names) => daRequest(conn, 'CMD_API_SSL', {
  method: 'POST', loginAs: user, timeout: 90_000, // the ACME exchange runs inside this call
  params: {
    domain: names[0], action: 'save', type: 'create', request: 'letsencrypt', name: names[0],
    keysize: 'secp384r1', encryption: 'sha256', submit: 'Save',
    ...Object.fromEntries(names.map((n, i) => [`le_select${i}`, n])),
  },
});

// Let's Encrypt for domain + www.domain (bare domain alone when www fails). Turns SSL on for
// the account when needed and back off when the request then fails. Never throws.
export async function requestLetsEncrypt(conn, { user, domain }) {
  let originalCfg, turnedSslOn = false;
  try {
    originalCfg = await daRequest(conn, 'CMD_API_SHOW_USER_CONFIG', { params: { user } });
    if (originalCfg?.ssl !== 'ON') {
      try {
        await daRequest(conn, 'CMD_API_MODIFY_USER', { method: 'POST', params: { ...buildCustomizeParams(originalCfg, { ssl: 'ON' }), user } });
      } catch (e) {
        return { ok: false, error: messageFor(e, 'ssl_not_allowed') };
      }
      turnedSslOn = true;
      const cfg = await daRequest(conn, 'CMD_API_SHOW_USER_CONFIG', { params: { user } });
      if (cfg?.ssl !== 'ON') return { ok: false, error: DA_MESSAGE.ssl_not_allowed };
    }
  } catch (e) {
    return { ok: false, error: messageFor(e) };
  }

  let issued = [domain, `www.${domain}`], firstError = null;
  try {
    await issueLetsEncrypt(conn, user, issued);
  } catch (e) {
    firstError = e;
    issued = [domain];
    try {
      await issueLetsEncrypt(conn, user, issued);
    } catch {
      let error = classifySslFailure(firstError);
      if (turnedSslOn) {
        try {
          await daRequest(conn, 'CMD_API_MODIFY_USER', { method: 'POST', params: { ...buildCustomizeParams(originalCfg, {}), user } });
        } catch {
          error += '; de SSL-instelling van het account kon niet worden teruggezet';
        }
      }
      return { ok: false, error };
    }
  }
  let cert = null;
  try { cert = await getCertificateInfo(conn, user, domain); } catch { /* the issue itself succeeded */ }
  return {
    ok: true, names: cert?.names ?? issued, expiresAt: cert?.expiresAt ?? null, wwwDropped: Boolean(firstError),
    ...(firstError && { wwwError: classifySslFailure(firstError) }),
  };
}
