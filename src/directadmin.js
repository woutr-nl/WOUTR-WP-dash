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

export async function daRequest(conn, cmd, { method = 'GET', params = {}, loginAs } = {}) {
  const user = loginAs ? `${conn.username}|${loginAs}` : conn.username;
  const auth = `Basic ${Buffer.from(`${user}:${conn.password}`).toString('base64')}`;
  const query = new URLSearchParams({ ...params, json: 'yes' });
  let url = `${conn.url}/${cmd}`;
  let body;
  if (method === 'GET') url += `?${query}`;
  else body = query; // fetch sends it as application/x-www-form-urlencoded
  let res, text;
  try {
    res = await fetch(url, { method, body, headers: { Authorization: auth }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
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
function messageFor(e, deniedCode) {
  if (!(e instanceof DaError)) return DA_MESSAGE.unreachable;
  if (e.code === 'denied' && deniedCode) return new DaError(deniedCode, e.detail).message;
  return e.message;
}

function userList(data) {
  const list = Array.isArray(data) ? data : data?.list;
  return (Array.isArray(list) ? list : Object.values(list ?? {})).filter((u) => typeof u === 'string');
}

export async function testConnection(conn) {
  try {
    const users = userList(await daRequest(conn, 'CMD_API_SHOW_USERS'));
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

// SHOW_USER_CONFIG → MODIFY_USER action=customize with ssh=ON. Generic read-modify-write:
// DirectAdmin turns absent checkboxes OFF and resets omitted limits, so every ON flag,
// unlimited limit and numeric limit is re-sent, including ones this code doesn't know.
export function buildCustomizeParams(userConfig) {
  const p = {};
  for (const [k, v] of Object.entries(userConfig ?? {})) {
    if (CONFIG_META.has(k) || typeof v !== 'string') continue;
    if (v === 'ON') p[k] = 'ON';
    else if (v === 'unlimited') p[`u${k}`] = 'ON';
    else if (/^\d+(\.\d+)?$/.test(v)) p[k] = v;
  }
  for (const k of PASS_THROUGH) if (typeof userConfig?.[k] === 'string') p[k] = userConfig[k];
  return { ...p, ssh: 'ON', action: 'customize', user: userConfig?.username };
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
    let removedOld = false;
    for (const e of entries.filter((x) => old.has(x.blob))) {
      if (!e.fingerprint) return { ok: false, error: 'Vorige dashboardsleutel gevonden, maar DirectAdmin gaf geen vingerafdruk om hem te verwijderen.' };
      await daRequest(conn, 'CMD_SSH_KEYS', {
        method: 'POST', loginAs: user, params: { action: 'delete', type: 'authorized_keys', select0: e.fingerprint },
      });
      removedOld = true;
    }
    return { ok: true, removedOld };
  } catch (e) {
    return { ok: false, error: messageFor(e, deniedCode) };
  }
}
