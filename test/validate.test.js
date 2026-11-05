import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSite, validateDaConnection } from '../src/validate.js';

const base = {
  client_slug: 'acme',
  theme_type: 'block',
  ssh_target: 'deploy@acme.example.nl',
  wp_path: '/home/deploy/public_html',
  site_url: 'https://www.acme.nl',
  site_title: 'Acme',
  admin_email: 'web@acme.nl',
  mail_mode: 'none',
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

test('a Bricks site takes SMTP and Resend settings like a block site', () => {
  const bricks = { ...base, theme_type: 'bricks' };
  const smtp = validateSite({ ...bricks, mail_mode: 'smtp', smtp_host: 'mail.acme.nl', smtp_port: '465', smtp_encryption: 'ssl', smtp_pass: 'x' });
  assert.deepEqual(smtp.errors, {});
  assert.equal(smtp.values.smtp_host, 'mail.acme.nl');
  assert.equal(smtp.values.smtp_pass, 'x');
  const resend = validateSite({ ...bricks, mail_mode: 'resend', resend_from: 'web@acme.nl', resend_api_key: 're_x' });
  assert.deepEqual(resend.errors, {});
  assert.equal(validateSite(bricks).values.smtp_pass, undefined, 'a stored SMTP password is kept');
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

test('mail_mode: Geen, SMTP or Resend', () => {
  for (const m of [undefined, '', 'mailgun']) assert.equal(validateSite({ ...base, mail_mode: m }).errors.mail_mode, 'Kies Geen, SMTP of Resend.', String(m));
  assert.equal(validateSite({ ...base, mail_mode: ' none ' }).values.mail_mode, 'none');
  assert.equal(validateSite({ ...base, mail_mode: 'smtp' }).errors.smtp_host, 'Verplicht veld.');
  assert.deepEqual(validateSite({ ...base, mail_mode: 'smtp', smtp_host: 'mail.acme.nl' }).errors, {});
});

test('resend: from address and a key are required', () => {
  const resend = { ...base, mail_mode: 'resend', resend_from: 'web@acme.nl', resend_from_name: 'Acme', resend_api_key: 're_x' };
  const ok = validateSite(resend);
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.resend_api_key, 're_x');
  assert.equal(ok.values.resend_from_name, 'Acme');
  assert.equal(validateSite({ ...resend, resend_from: '' }).errors.resend_from, 'Verplicht veld.');
  assert.equal(validateSite({ ...resend, resend_from: 'geen-adres' }).errors.resend_from, 'Geen geldig e-mailadres.');
  assert.equal(validateSite({ ...resend, resend_api_key: '' }).errors.resend_api_key, 'Verplicht veld.');
  const kept = validateSite({ ...resend, resend_api_key: '' }, { hasResendKey: true });
  assert.deepEqual(kept.errors, {});
  assert.equal(kept.values.resend_api_key, undefined);
  assert.equal(validateSite({ ...resend, resend_api_key_clear: '1' }, { hasResendKey: true }).errors.resend_api_key, 'Verplicht veld.');
  assert.equal(validateSite({ ...base, resend_api_key_clear: '1' }, { hasResendKey: true }).values.resend_api_key, null);
  assert.ok(validateSite({ ...base, resend_from: '-x@acme.nl' }).errors.resend_from);
});

test('the inactive mail option keeps its values', () => {
  const { values, errors } = validateSite({ ...base, mail_mode: 'resend', resend_from: 'web@acme.nl', resend_api_key: 're_x',
    smtp_host: 'mail.acme.nl', smtp_user: 'u', smtp_pass: 'p' });
  assert.deepEqual(errors, {});
  assert.equal(values.smtp_host, 'mail.acme.nl');
  assert.equal(values.smtp_user, 'u');
  assert.equal(values.smtp_pass, 'p');
  const none = validateSite({ ...base, resend_from: 'web@acme.nl', resend_from_name: 'Acme' });
  assert.deepEqual(none.errors, {});
  assert.equal(none.values.resend_from, 'web@acme.nl');
});

test('da_username: optional, DirectAdmin username rules', () => {
  assert.equal(validateSite(base).values.da_username, null);
  assert.equal(validateSite({ ...base, da_username: ' klant_1 ' }).values.da_username, 'klant_1');
  for (const bad of ['Klant', '1klant', 'kl-ant', 'a'.repeat(33)])
    assert.match(validateSite({ ...base, da_username: bad }).errors.da_username, /DirectAdmin-gebruikersnaam/);
  assert.equal(validateSite({ ...base, da_username: '-klant' }).errors.da_username, "Mag niet met '-' beginnen.");
  assert.match(validateSite({ ...base, da_username: 'kl\nant' }).errors.da_username, /ongeldige tekens/);
});

test('validateDaConnection: https only, normalized, password required on create', () => {
  const ok = { url: ' https://da.example.nl:2222/ ', username: 'reseller', password: ' p w ' };
  const { values, errors } = validateDaConnection(ok);
  assert.deepEqual(errors, {});
  assert.deepEqual(values, { url: 'https://da.example.nl:2222', username: 'reseller', password: ' p w ' });
  for (const url of ['http://da.example.nl:2222', 'garbage', 'https://u:p@da.example.nl', '', '-https://x'])
    assert.ok(validateDaConnection({ ...ok, url }).errors.url, url);
  assert.ok(validateDaConnection({ ...ok, username: 'Res' }).errors.username);
  assert.ok(validateDaConnection({ ...ok, username: '-res' }).errors.username);
  assert.ok(validateDaConnection({ ...ok, username: '' }).errors.username);
  assert.equal(validateDaConnection({ ...ok, password: '' }).errors.password, 'Verplicht veld.');
  const keep = validateDaConnection({ ...ok, password: '' }, { hasPassword: true });
  assert.deepEqual(keep.errors, {});
  assert.equal(keep.values.password, undefined);
  assert.ok(validateDaConnection({ ...ok, password: 'a\nb' }).errors.password);
});

test('da_domain: lowercased, a real domain name, dropped without an account', () => {
  const da = { ...base, da_username: 'klant' };
  assert.equal(validateSite({ ...da, da_domain: ' Voorbeeld.NL ' }).values.da_domain, 'voorbeeld.nl');
  for (const bad of ['-x.nl', 'voorbeeld', 'a\nb.nl', 'a b.nl', 'x.nl.']) {
    assert.ok(validateSite({ ...da, da_domain: bad }).errors.da_domain, bad);
  }
  const none = validateSite({ ...base, da_domain: '-x' });
  assert.deepEqual(none.errors, {});
  assert.equal(none.values.da_domain, null);
  assert.equal(validateSite(da).values.da_domain, null);
});
