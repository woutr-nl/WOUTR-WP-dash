// Pure helpers for running the WOUTR-WP commands: argv, needed secret env vars,
// result parsing, log scrubbing, version comparison. No I/O.

export const ACTIONS = ['deploy', 'update', 'live'];

const smtpArgs = (site) => {
  const args = ['--smtp-host', site.smtp_host];
  if (site.smtp_port) args.push('--smtp-port', String(site.smtp_port));
  if (site.smtp_encryption) args.push('--smtp-encryption', site.smtp_encryption);
  if (site.smtp_user) args.push('--smtp-user', site.smtp_user);
  if (site.smtp_from) args.push('--smtp-from', site.smtp_from);
  if (site.smtp_from_name) args.push('--smtp-from-name', site.smtp_from_name);
  return args;
};

// SMTP is sent on deploy whenever the site has it, on update only on request; never for Bricks.
const sendsSmtp = (action, site, options) =>
  site.theme_type !== 'bricks' && !!site.smtp_host && (action === 'deploy' || (action === 'update' && options.apply_smtp === true));

export function buildArgs(action, site, options = {}) {
  const args = [site.client_slug, '--ssh', site.ssh_target, '--path', site.wp_path];
  const block = site.theme_type !== 'bricks';
  if (action === 'deploy') {
    args.push('--url', site.site_url, '--title', site.site_title, '--admin-email', site.admin_email,
      '--admin-user', site.admin_user);
    if (site.db_name) {
      args.push('--db-name', site.db_name, '--db-user', site.db_user);
      if (site.db_host) args.push('--db-host', site.db_host);
    }
  }
  if (action === 'deploy' || action === 'update') {
    if (options.version) args.push('--version', options.version);
    if (block && options.parent_version) args.push('--parent-version', options.parent_version);
    if (sendsSmtp(action, site, options)) args.push(...smtpArgs(site));
  }
  if (action === 'deploy' && options.overwrite === true) args.push('--overwrite');
  if (action === 'live' && options.force === true) args.push('--force');
  return args;
}

export function buildEnvNames(action, site, options = {}) {
  const names = [];
  if (action === 'deploy' && site.db_pass_enc) names.push('WP_DB_PASS');
  if (action === 'deploy' && site.theme_type === 'bricks') names.push('BRICKS_LICENSE_KEY');
  if (sendsSmtp(action, site, options) && site.smtp_pass_enc) names.push('WOUTR_SMTP_PASS');
  return names;
}

export function parseResult(stdout) {
  const result = {};
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = /^([a-z][a-z0-9_]*)=(.*)$/.exec(line);
    if (m) result[m[1]] = m[2];
  }
  const adminPassword = result.admin_password;
  delete result.admin_password;
  return { result, adminPassword };
}

export const MASK = '[geheim]';

// secretValues: strings; multi-line values (the SSH key) are scrubbed per line.
export function makeScrubber(secretValues) {
  const parts = new Set();
  for (const v of secretValues) {
    if (!v) continue;
    const s = String(v);
    if (/[\r\n]/.test(s) || s.includes('\\n')) {
      for (const l of s.split(/\r?\n|\\n/)) {
        const t = l.trim();
        if (t && !t.startsWith('-----')) parts.add(t);
      }
    } else parts.add(s);
  }
  // Longest first so a secret containing another is masked whole.
  const list = [...parts].sort((a, b) => b.length - a.length);
  return (text) => list.reduce((acc, p) => acc.replaceAll(p, MASK), String(text));
}

// Splits a chunked stream into whole lines so a secret never straddles a chunk boundary.
export function makeLineBuffer(onLine) {
  let rest = '';
  return {
    push(chunk) {
      rest += chunk;
      const lines = rest.split('\n');
      rest = lines.pop();
      for (const l of lines) onLine(l + '\n');
    },
    end() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export const isRollback = (chosen, installed) => !!chosen && !!installed && compareVersions(chosen, installed) < 0;

export function statusFromExit(action, code) {
  if (code === 0) return 'success';
  if (code === 3 && (action === 'deploy' || action === 'live')) return 'needs_confirmation';
  return 'failed';
}

// Outcome of an `ssh <target> true` connection test. A changed host key is checked
// first: it must never read as a key problem.
export function classifySshTest(code, stderr) {
  if (code === 0) return 'ok';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(stderr)) return 'hostkey';
  if (/Permission denied/.test(stderr)) return 'denied';
  return 'unreachable';
}
