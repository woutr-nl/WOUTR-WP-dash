import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArgs, buildEnvNames, parseResult, makeScrubber, makeLineBuffer, compareVersions, isRollback, statusFromExit,
} from '../src/runs.js';

const block = {
  client_slug: 'acme', theme_type: 'block', ssh_target: 'deploy@acme.nl', wp_path: '/home/deploy/www',
  site_url: 'https://www.acme.nl', site_title: 'Acme BV', admin_email: 'web@acme.nl', admin_user: 'beheer',
  db_name: null, db_user: null, db_host: 'localhost', db_pass_enc: 'v1:x',
  smtp_host: null, smtp_port: 587, smtp_encryption: 'tls', smtp_user: null, smtp_from: null, smtp_from_name: null, smtp_pass_enc: null,
};
const withSmtp = { ...block, smtp_host: 'smtp.acme.nl', smtp_user: 'mail@acme.nl', smtp_from: 'web@acme.nl', smtp_from_name: 'Acme', smtp_pass_enc: 'v1:y' };
const bricks = { ...block, theme_type: 'bricks' };
const has = (args, flag) => args.includes(flag);

test('deploy block: base args, no versions, no smtp', () => {
  assert.deepEqual(buildArgs('deploy', block, {}), [
    'acme', '--ssh', 'deploy@acme.nl', '--path', '/home/deploy/www', '--url', 'https://www.acme.nl',
    '--title', 'Acme BV', '--admin-email', 'web@acme.nl', '--admin-user', 'beheer',
  ]);
});

test('deploy block with versions, smtp and db flags', () => {
  const args = buildArgs('deploy', { ...withSmtp, db_name: 'wp', db_user: 'wpu' }, { version: '1.2.0', parent_version: '2.0.1' });
  assert.deepEqual(args.slice(args.indexOf('--db-name'), args.indexOf('--db-name') + 6), ['--db-name', 'wp', '--db-user', 'wpu', '--db-host', 'localhost']);
  assert.equal(args[args.indexOf('--version') + 1], '1.2.0');
  assert.equal(args[args.indexOf('--parent-version') + 1], '2.0.1');
  assert.equal(args[args.indexOf('--smtp-host') + 1], 'smtp.acme.nl');
  assert.equal(args[args.indexOf('--smtp-from-name') + 1], 'Acme');
  assert.ok(!has(args, '--overwrite'));
});

test('deploy bricks never gets --parent-version or --smtp-*', () => {
  const args = buildArgs('deploy', { ...bricks, smtp_host: 'smtp.x' }, { version: '1.0.0', parent_version: '2.0.0' });
  assert.ok(has(args, '--version'));
  assert.ok(!has(args, '--parent-version'));
  assert.ok(!args.some((a) => a.startsWith('--smtp')));
});

test('--overwrite / --force only when the option is exactly true', () => {
  assert.ok(!has(buildArgs('deploy', block, { overwrite: '1' }), '--overwrite'));
  assert.ok(has(buildArgs('deploy', block, { overwrite: true }), '--overwrite'));
  assert.ok(!has(buildArgs('live', block, { force: 'true' }), '--force'));
  assert.deepEqual(buildArgs('live', block, { force: true }), ['acme', '--ssh', 'deploy@acme.nl', '--path', '/home/deploy/www', '--force']);
  assert.ok(!has(buildArgs('update', block, { overwrite: true, force: true }), '--overwrite'));
});

test('update: smtp only with apply_smtp; no deploy flags', () => {
  const plain = buildArgs('update', withSmtp, { version: '1.0.0' });
  assert.deepEqual(plain, ['acme', '--ssh', 'deploy@acme.nl', '--path', '/home/deploy/www', '--version', '1.0.0']);
  assert.ok(has(buildArgs('update', withSmtp, { apply_smtp: true }), '--smtp-host'));
});

test('no secret ever appears in argv', () => {
  for (const a of ['deploy', 'update', 'live']) {
    const args = buildArgs(a, withSmtp, { apply_smtp: true });
    assert.ok(!args.some((x) => x.startsWith('v1:')));
  }
});

test('buildEnvNames per action', () => {
  assert.deepEqual(buildEnvNames('deploy', block), ['WP_DB_PASS']);
  assert.deepEqual(buildEnvNames('deploy', withSmtp), ['WP_DB_PASS', 'WOUTR_SMTP_PASS']);
  assert.deepEqual(buildEnvNames('deploy', bricks), ['WP_DB_PASS', 'BRICKS_LICENSE_KEY']);
  assert.deepEqual(buildEnvNames('update', withSmtp, {}), []);
  assert.deepEqual(buildEnvNames('update', withSmtp, { apply_smtp: true }), ['WOUTR_SMTP_PASS']);
  assert.deepEqual(buildEnvNames('live', withSmtp, { force: true }), []);
});

test('parseResult extracts admin_password and drops it from the result', () => {
  const { result, adminPassword } = parseResult(
    'status=ok\nurl=https://www.acme.nl\nadmin_user=beheer\nadmin_password=s3cr=et\ntheme=acme\ntheme_version=1.2.0\nparent_theme=woutr\nparent_version=2.0.1\n');
  assert.equal(adminPassword, 's3cr=et');
  assert.ok(!('admin_password' in result));
  assert.equal(result.theme_version, '1.2.0');
  assert.equal(result.parent_version, '2.0.1');
});

test('parseResult: failure triple, check values, junk ignored', () => {
  const { result, adminPassword } = parseResult('garbage line\nstatus=failed\nfailed_step=checks\nerror=Controles mislukt (https)\ncheck_https=fail:HTTP 500\n=x\n');
  assert.equal(adminPassword, undefined);
  assert.deepEqual(result, { status: 'failed', failed_step: 'checks', error: 'Controles mislukt (https)', check_https: 'fail:HTTP 500' });
});

test('makeScrubber masks every secret, every occurrence, and SSH key lines', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAb3BlbnNzaC1rZXktdjE\nQUFBQUFBQUFBQUE=\n-----END OPENSSH PRIVATE KEY-----\n';
  const scrub = makeScrubber(['dbpass', 'smtppass', '', undefined, key]);
  const out = scrub('dbpass and smtppass then dbpass; AAAAb3BlbnNzaC1rZXktdjE QUFBQUFBQUFBQUE=');
  assert.ok(!/dbpass|smtppass|AAAAb3|QUFBQ/.test(out));
  assert.equal(out.split('[geheim]').length - 1, 5);
  // A one-line key with literal \n is split the same way.
  assert.ok(!makeScrubber([key.replaceAll('\n', '\\n')])('x QUFBQUFBQUFBQUE=').includes('QUFBQ'));
});

test('a secret split over two chunks is still scrubbed via the line buffer', () => {
  const scrub = makeScrubber(['hunter2-secret']);
  let log = '';
  const buf = makeLineBuffer((l) => { log += scrub(l); });
  buf.push('connecting with hunt');
  buf.push('er2-secret now\nnext ');
  buf.push('line');
  buf.end();
  assert.equal(log, 'connecting with [geheim] now\nnext line');
});

test('compareVersions / isRollback', () => {
  assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(isRollback('1.2.0', '1.10.0'), true);
  assert.equal(isRollback('1.10.0', '1.10.0'), false);
  assert.equal(isRollback('1.0.0', null), false);
  assert.equal(isRollback('', '1.0.0'), false);
});

test('statusFromExit', () => {
  assert.equal(statusFromExit('deploy', 0), 'success');
  assert.equal(statusFromExit('deploy', 3), 'needs_confirmation');
  assert.equal(statusFromExit('live', 3), 'needs_confirmation');
  assert.equal(statusFromExit('update', 3), 'failed');
  assert.equal(statusFromExit('deploy', 1), 'failed');
  assert.equal(statusFromExit('live', 2), 'failed');
  assert.equal(statusFromExit('deploy', null), 'failed');
});
