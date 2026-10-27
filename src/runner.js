// Runs the real WOUTR-WP commands from a persistent checkout of its main branch
// and records every run in the `runs` table.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import config from './config.js';
import { pool } from './db.js';
import { encrypt } from './crypto.js';
import { getActivePrivateKey } from './sshkey.js';
import { buildArgs, parseResult, makeScrubber, makeLineBuffer, statusFromExit, compareVersions, classifySshTest } from './runs.js';

const REPO = 'woutr-nl/WOUTR-WP';
const DATA = '/data';
const CHECKOUT = `${DATA}/woutr-wp`;
const HOME = homedir();
const ASKPASS = `${HOME}/.git-askpass`;
const LOG_CAP = 1024 * 1024;

// ponytail: in-memory, single instance — same ceiling as the login limiter.
const active = new Map(); // siteId -> runId
let scriptsRunning = 0;
let checkoutLock = Promise.resolve();

export async function initRunner() {
  await mkdir(`${HOME}/.ssh`, { recursive: true, mode: 0o700 });
  await mkdir(`${DATA}/ssh`, { recursive: true });
  // accept-new: first connection trusts and remembers the host key (on the volume);
  // a changed key makes ssh refuse to connect.
  await writeFile(`${HOME}/.ssh/config`, `Host *
  IdentityFile ~/.ssh/id
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ${DATA}/ssh/known_hosts
  BatchMode yes
`, { mode: 0o600 });
  // The token reaches git only through this helper, never in a URL or argument.
  await writeFile(ASKPASS, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) echo "$GIT_TOKEN" ;; esac\n', { mode: 0o700 });
}

export const isBusy = (siteId) => active.has(Number(siteId));
export const anyBusy = () => active.size > 0;

// Never inherit process.env: it holds the dashboard's own secrets.
const baseEnv = () => ({ PATH: process.env.PATH, HOME, LANG: process.env.LANG || 'C.UTF-8' });

function exec(cmd, args, { cwd, env, signal, onStdout, onStderr }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      onStderr(`${cmd}: ${e.message}\n`);
      return resolve(null);
    }
    child.stdout.setEncoding('utf8').on('data', onStdout);
    child.stderr.setEncoding('utf8').on('data', onStderr);
    child.on('error', (e) => { onStderr(`${cmd}: ${e.message}\n`); resolve(null); });
    child.on('close', (code) => resolve(code));
  });
}

// Updates the checkout to the current main. Returns true on success.
async function refreshCheckout(needLfs, out) {
  const env = { ...baseEnv(), GIT_ASKPASS: ASKPASS, GIT_TOKEN: config.githubToken, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' };
  const git = (args, cwd = CHECKOUT) => exec('git', args, { cwd, env, onStdout: out, onStderr: out });
  // ponytail: shared checkout, refresh skipped during overlap; per-run worktrees if concurrent freshness ever matters.
  const skip = scriptsRunning > 0 && existsSync(`${CHECKOUT}/.git`);
  if (!skip) {
    if (!existsSync(`${CHECKOUT}/.git`)) {
      out(`WOUTR-WP ophalen (${REPO}, main)…\n`);
      if (await git(['clone', '--depth', '1', '--branch', 'main', `https://github.com/${REPO}.git`, CHECKOUT], DATA) !== 0) return false;
    } else {
      out('WOUTR-WP bijwerken naar de huidige main…\n');
      if (await git(['fetch', '--depth', '1', 'origin', 'main']) !== 0) return false;
      if (await git(['reset', '--hard', 'FETCH_HEAD']) !== 0) return false;
      if (await git(['clean', '-fd']) !== 0) return false;
    }
  } else out('Andere run actief: WOUTR-WP-checkout niet bijgewerkt.\n');
  // During overlap only fetch LFS files still missing (pointers): it never rewrites a file a running script may use.
  if (needLfs && (!skip || await lfsMissing(env))) {
    if (await git(['lfs', 'install', '--skip-repo']) !== 0) return false;
    if (await git(['lfs', 'pull']) !== 0) return false;
  }
  return true;
}

// True when an LFS file in the checkout is still a pointer ('-' in `git lfs ls-files`).
export async function lfsMissing(env, cwd = CHECKOUT) {
  let listed = '';
  const code = await exec('git', ['lfs', 'ls-files'], { cwd, env, onStdout: (c) => { listed += c; }, onStderr: () => {} });
  return code !== 0 || /^\S+ - /m.test(listed);
}

// site: full sites row (incl. *_enc columns). secrets: env name -> plaintext value.
// Resolves with the run id once the run is recorded; the command continues in the background.
export async function startRun(site, action, options, secrets) {
  const siteId = Number(site.id);
  if (active.has(siteId)) throw busyError();
  active.set(siteId, 0);
  let runId;
  try {
    const { rows: busy } = await pool.query(`SELECT 1 FROM runs WHERE site_id = $1 AND status = 'running'`, [siteId]);
    if (busy.length) throw busyError();
    ({ rows: [{ id: runId }] } = await pool.query(
      'INSERT INTO runs (site_id, action, options) VALUES ($1, $2, $3) RETURNING id', [siteId, action, options]));
    active.set(siteId, runId);
  } catch (e) {
    active.delete(siteId);
    throw e;
  }
  execute(site, action, options, secrets, runId)
    .catch((e) => console.error(`Run ${runId} mislukt: ${e.message}`))
    .finally(() => active.delete(siteId));
  return runId;
}

function busyError() {
  const e = new Error('Er is al een run bezig voor deze site.');
  e.busy = true;
  return e;
}

async function execute(site, action, options, secrets, runId) {
  const known = [...Object.values(secrets), config.githubToken, config.bricksLicenseKey, getActivePrivateKey(), config.sshPrivateKey];
  let scrub = makeScrubber(known);

  let log = '';
  let capped = false;
  let writes = Promise.resolve();
  let queued = false;
  const flush = () => {
    if (queued) return;
    queued = true;
    writes = writes.then(() => {
      queued = false;
      return pool.query('UPDATE runs SET log = $2 WHERE id = $1', [runId, log]);
    }).catch((e) => console.error(`Log van run ${runId} niet opgeslagen: ${e.message}`));
  };
  const append = (line) => {
    if (capped) return;
    log += scrub(line);
    if (log.length > LOG_CAP) {
      log = log.slice(0, LOG_CAP) + '\n… [ingekort]\n';
      capped = true;
    }
    flush();
  };
  const stderr = makeLineBuffer(append);

  let code;
  let stdout = '';
  let result;
  let adminPassword;
  const lock = checkoutLock.then(async () => {
    if (!await refreshCheckout(action === 'deploy' && site.theme_type === 'bricks', (c) => stderr.push(c))) return false;
    scriptsRunning++; // inside the lock, so no refresh can start before this script does
    return true;
  });
  checkoutLock = lock.catch(() => {});
  if (!await lock) {
    stderr.end();
    code = null;
    const lines = log.trim().split('\n');
    result = { status: 'failed', failed_step: 'checkout', error: lines[lines.length - 1] || 'WOUTR-WP ophalen mislukt' };
  } else {
    try {
      // stdin ignored: no tty, so the commands exit 3 instead of prompting.
      code = await exec('bash', [`tools/${action}.sh`, ...buildArgs(action, site, options)], {
        cwd: CHECKOUT,
        env: { ...baseEnv(), GH_TOKEN: config.githubToken, ...secrets },
        onStdout: (c) => { stdout += c; }, // never stored raw: may carry admin_password
        onStderr: (c) => stderr.push(c),
      });
    } finally {
      scriptsRunning--;
    }
    stderr.end();
    ({ result, adminPassword } = parseResult(stdout));
  }

  const status = statusFromExit(action, code);
  if (adminPassword) {
    scrub = makeScrubber([...known, adminPassword]);
    if (action === 'deploy' && status === 'success') {
      await pool.query('UPDATE sites SET admin_pass_enc = $2 WHERE id = $1', [site.id, encrypt(adminPassword, config.encryptionKey)]);
    }
  }
  for (const k of Object.keys(result)) result[k] = scrub(result[k]);
  log = scrub(log);
  await writes;
  await pool.query(`UPDATE runs SET status = $2, exit_code = $3, result = $4, log = $5, finished_at = now() WHERE id = $1`,
    [runId, status, code, result, log]);
}

// Logs in with the dashboard key and runs `true`: changes nothing, no run row, no run lock.
// Same ~/.ssh/config as runs, so the same identity and host-key rules apply.
export async function testSshConnection(sshTarget) {
  let stderr = '';
  const code = await exec('ssh', ['-o', 'ConnectTimeout=10', '-o', 'NumberOfPasswordPrompts=0', '--', sshTarget, 'true'], {
    env: baseEnv(), signal: AbortSignal.timeout(20_000), onStdout: () => {}, onStderr: (c) => { stderr += c; },
  });
  const scrub = makeScrubber([getActivePrivateKey(), config.sshPrivateKey]);
  const detail = scrub(stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '');
  return { outcome: classifySshTest(code, stderr), detail };
}

// Available versions for a slug's child theme and for the woutr parent theme, newest first.
export async function listReleases(slug) {
  // ponytail: first 100 releases only; paginate when the repo outgrows that.
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, {
    headers: { Authorization: `Bearer ${config.githubToken}`, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const tags = (await res.json()).filter((r) => !r.draft).map((r) => r.tag_name);
  const pick = (prefix) => tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))
    .sort((a, b) => compareVersions(b, a));
  return { theme: pick(`${slug}-v`), parent: pick('woutr-v') };
}
