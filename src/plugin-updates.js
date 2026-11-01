// Newest WOUTR-plugin release for the public update routes, cached in memory: many sites
// checking must not reach GitHub, and GitHub being down must not reach the sites.
// Stands apart from the runner and the health check: no DB, no run lock, no checkout.
import config from './config.js';
import { compareVersions } from './runs.js';

const REPO = 'woutr-nl/WOUTR-WP';
const TAG = /^woutr-plugin-v(\d+(?:\.\d+)*)$/;
const ASSET = 'woutr-plugin.zip';
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const TTL = 5 * 60_000;
const BACKOFF = 60_000;
const auth = () => ({ Authorization: `Bearer ${config.githubToken}` });

// ponytail: in-memory, single instance — same ceiling as the run lock.
let cache = null; // { version, zip, tested, requires, requires_php, fetchedAt }
let inflight = null;
let nextAttemptAt = 0; // after a failed refresh: no new GitHub call before this moment
let lastError = null;

async function newestRelease() {
  // ponytail: first 100 releases only; paginate when the repo outgrows that.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { ...auth(), Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const candidates = (await res.json()).flatMap((r) => {
    const version = r.tag_name.match(TAG)?.[1];
    const asset = r.assets?.find((a) => a.name === ASSET);
    return !r.draft && !r.prerelease && version && asset ? [{ version, asset }] : [];
  });
  if (!candidates.length) throw new Error('geen pluginrelease met woutr-plugin.zip gevonden');
  return candidates.reduce((a, b) => (compareVersions(b.version, a.version) > 0 ? b : a));
}

async function downloadZip(asset) {
  // ponytail: zip cached in RAM; stream to disk if the plugin ever outgrows this.
  if (asset.size > MAX_ASSET_SIZE) throw new Error(`${ASSET} is groter dan 50 MB`);
  // The API URL, as the repo is private. fetch drops Authorization on the redirect to
  // GitHub's storage backend, which that backend requires.
  const res = await fetch(asset.url, {
    headers: { ...auth(), Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// WordPress headers of the plugin at its release tag. Optional: without them the update still serves.
async function pluginHeaders(version) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/plugin/woutr-plugin.php?ref=woutr-plugin-v${version}`, {
      headers: { ...auth(), Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const php = await res.text();
    const header = (name) => php.match(new RegExp(`^\\s*\\*?\\s*${name}:[ \\t]*(\\S+)`, 'mi'))?.[1];
    return { tested: header('Tested up to'), requires: header('Requires at least'), requires_php: header('Requires PHP') };
  } catch (e) {
    console.error(`Pluginheaders ophalen mislukt: ${e.message}`);
    return {};
  }
}

async function refresh() {
  const { version, asset } = await newestRelease();
  if (cache?.version === version) {
    cache.fetchedAt = Date.now();
    return;
  }
  const zip = await downloadZip(asset);
  const headers = await pluginHeaders(version);
  cache = { version, zip, ...headers, fetchedAt: Date.now() };
}

const refreshOnce = () => (inflight ??= refresh()
  .then(() => {
    nextAttemptAt = 0;
    lastError = null;
  }, (e) => {
    console.error(`Pluginupdate verversen mislukt: ${e.message}`);
    lastError = e;
    nextAttemptAt = Date.now() + BACKOFF;
    throw e;
  })
  .finally(() => { inflight = null; }));

// Stale-while-revalidate: once anything is cached, an update check never waits on GitHub
// and a GitHub failure leaves the last known version in place. Throws only without a cache.
// After a failure at most one refresh per BACKOFF, so public requests can't drain the shared token.
export async function getPluginUpdate() {
  const backingOff = Date.now() < nextAttemptAt;
  if (!cache) {
    if (backingOff) throw lastError;
    await refreshOnce();
    return cache;
  }
  if (!backingOff && Date.now() - cache.fetchedAt >= TTL) refreshOnce().catch(() => {});
  return cache;
}
