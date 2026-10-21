import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSite } from '../src/validate.js';

const base = {
  client_slug: 'acme',
  theme_type: 'block',
  ssh_target: 'deploy@acme.example.nl',
  wp_path: '/home/deploy/public_html',
  site_url: 'https://www.acme.nl',
  site_title: 'Acme',
  admin_email: 'web@acme.nl',
};

test('happy path applies defaults', () => {
  const { values, errors } = validateSite({ ...base, admin_user: '', db_host: '', smtp_port: '', smtp_encryption: '' });
  assert.deepEqual(errors, {});
  assert.equal(values.admin_user, 'beheer');
  assert.equal(values.db_host, 'localhost');
  assert.equal(values.smtp_port, 587);
  assert.equal(values.smtp_encryption, 'tls');
  assert.equal(values.db_pass, undefined);
  assert.equal(values.smtp_pass, undefined);
});

test('values are trimmed', () => {
  const { values } = validateSite({ ...base, site_title: '  Acme  ' });
  assert.equal(values.site_title, 'Acme');
});

test('leading dash rejected on every text field', () => {
  for (const f of ['site_title', 'admin_email', 'admin_user', 'wp_path', 'db_name', 'db_host', 'smtp_host', 'smtp_user', 'smtp_from_name']) {
    const { errors } = validateSite({ ...base, db_user: 'u', [f]: '-x' });
    assert.match(errors[f], /'-'/, f);
  }
});

test('malformed SSH targets rejected', () => {
  for (const t of ['foo', 'user@', '@host', 'user@host:22', 'a b@host']) {
    assert.ok(validateSite({ ...base, ssh_target: t }).errors.ssh_target, t);
  }
});

test('only http(s) URLs', () => {
  assert.ok(validateSite({ ...base, site_url: 'ftp://acme.nl' }).errors.site_url);
  assert.ok(validateSite({ ...base, site_url: 'acme.nl' }).errors.site_url);
  assert.ok(!validateSite({ ...base, site_url: 'http://acme.nl' }).errors.site_url);
});

test('control characters rejected', () => {
  assert.ok(validateSite({ ...base, site_title: 'Acme\nX' }).errors.site_title);
  assert.ok(validateSite({ ...base, db_pass: 'a\x00b' }).errors.db_pass);
});

test('required fields', () => {
  const { errors } = validateSite({});
  for (const f of ['client_slug', 'theme_type', 'ssh_target', 'wp_path', 'site_url', 'site_title', 'admin_email'])
    assert.ok(errors[f], f);
});

test('client slug shape', () => {
  assert.ok(validateSite({ ...base, client_slug: 'Acme/../x' }).errors.client_slug);
});

test('db name and user go together', () => {
  assert.ok(validateSite({ ...base, db_name: 'wp' }).errors.db_user);
  assert.deepEqual(validateSite({ ...base, db_name: 'wp', db_user: 'wpu' }).errors, {});
});

test('SMTP on a Bricks site rejected', () => {
  const bricks = { ...base, theme_type: 'bricks' };
  for (const [f, v] of [['smtp_host', 'mail.acme.nl'], ['smtp_port', '465'], ['smtp_encryption', 'ssl'], ['smtp_pass', 'x']]) {
    assert.match(validateSite({ ...bricks, [f]: v }).errors.smtp, /Bricks/, f);
  }
  const ok = validateSite(bricks);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.smtp_pass, null, 'stored SMTP secret is cleared on Bricks');
});

test('bad SMTP port and encryption', () => {
  for (const p of ['0', '70000', 'abc', '5.5']) assert.ok(validateSite({ ...base, smtp_port: p }).errors.smtp_port, p);
  assert.ok(validateSite({ ...base, smtp_encryption: 'starttls' }).errors.smtp_encryption);
  assert.equal(validateSite({ ...base, smtp_port: '465' }).values.smtp_port, 465);
});

test('secret semantics: blank keeps, value replaces, wissen clears', () => {
  assert.equal(validateSite({ ...base, db_pass: '' }).values.db_pass, undefined);
  assert.equal(validateSite({ ...base, db_pass: ' -geheim ' }).values.db_pass, ' -geheim ');
  assert.equal(validateSite({ ...base, db_pass: 'x', db_pass_clear: '1' }).values.db_pass, null);
  assert.equal(validateSite({ ...base, smtp_pass_clear: '1' }).values.smtp_pass, null);
});
