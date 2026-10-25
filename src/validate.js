// Pure validation of the site form. Returns { values, errors } where errors maps
// field -> Dutch message. Secrets: values.db_pass / values.smtp_pass are
// undefined (keep stored), null (clear stored) or a string (replace).

const CONTROL = /[\x00-\x1f\x7f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const SSH_TARGET = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$/;

const TEXT_FIELDS = [
  'client_slug', 'theme_type', 'ssh_target', 'wp_path', 'site_url', 'site_title',
  'admin_email', 'admin_user', 'db_name', 'db_user', 'db_host',
  'smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_user', 'smtp_from', 'smtp_from_name',
];
const SMTP_FIELDS = ['smtp_host', 'smtp_port', 'smtp_encryption', 'smtp_user', 'smtp_from', 'smtp_from_name'];

// existing.hasSmtpPass: the site already has a stored SMTP password.
export function validateSite(input, { hasSmtpPass = false } = {}) {
  const values = {};
  const errors = {};
  const err = (field, msg) => { errors[field] ??= msg; };

  for (const f of TEXT_FIELDS) {
    const v = typeof input[f] === 'string' ? input[f].trim() : '';
    values[f] = v;
    if (CONTROL.test(v)) err(f, 'Bevat ongeldige tekens (bijv. een regeleinde).');
    else if (v.startsWith('-')) err(f, "Mag niet met '-' beginnen.");
  }
  const need = (f, msg = 'Verplicht veld.') => { if (!values[f]) err(f, msg); };

  need('client_slug');
  if (values.client_slug && !SLUG.test(values.client_slug))
    err('client_slug', 'Alleen kleine letters, cijfers, punt, - en _ (een mapnaam onder clients/).');

  if (!['block', 'bricks'].includes(values.theme_type)) err('theme_type', 'Kies Blokthema of Bricks.');

  need('ssh_target');
  if (values.ssh_target && !SSH_TARGET.test(values.ssh_target))
    err('ssh_target', 'Gebruik de vorm gebruiker@host.');

  need('wp_path');

  need('site_url');
  if (values.site_url) {
    let url;
    try { url = new URL(values.site_url); } catch { /* invalid */ }
    if (!url || !['http:', 'https:'].includes(url.protocol))
      err('site_url', 'Geef een geldige URL die met http:// of https:// begint.');
  }

  need('site_title');
  need('admin_email');
  if (values.admin_email && !EMAIL.test(values.admin_email)) err('admin_email', 'Geen geldig e-mailadres.');
  values.admin_user ||= 'beheer';

  if (!!values.db_name !== !!values.db_user) {
    err(values.db_name ? 'db_user' : 'db_name', 'Vul databasenaam en databasegebruiker allebei in, of allebei niet.');
  }
  values.db_host ||= 'localhost';
  for (const f of ['db_name', 'db_user']) values[f] ||= null;

  values.db_pass = secret(input, 'db_pass', err);
  values.smtp_pass = secret(input, 'smtp_pass', err);

  if (values.theme_type === 'bricks') {
    const used = SMTP_FIELDS.some((f) => values[f]) || typeof values.smtp_pass === 'string';
    if (used) err('smtp', 'SMTP-instellingen zijn niet mogelijk bij een Bricks-thema.');
    else if (hasSmtpPass && values.smtp_pass !== null) {
      err('smtp', 'Deze site heeft nog een opgeslagen SMTP-wachtwoord. Kies eerst Blokthema, vink bij het SMTP-wachtwoord "Wissen" aan en sla op; kies daarna Bricks.');
    }
    values.smtp_pass = null; // never keep an SMTP secret on a Bricks site
  }

  if (values.smtp_port) {
    const port = Number(values.smtp_port);
    if (!/^\d+$/.test(values.smtp_port) || port < 1 || port > 65535) err('smtp_port', 'Poort moet een getal van 1 t/m 65535 zijn.');
    values.smtp_port = port;
  } else values.smtp_port = 587;

  values.smtp_encryption ||= 'tls';
  if (!['none', 'ssl', 'tls'].includes(values.smtp_encryption)) err('smtp_encryption', 'Kies none, ssl of tls.');

  if (values.smtp_from && !EMAIL.test(values.smtp_from)) err('smtp_from', 'Geen geldig e-mailadres.');
  for (const f of ['smtp_host', 'smtp_user', 'smtp_from', 'smtp_from_name']) values[f] ||= null;

  return { values, errors };
}

// Secrets are not trimmed (spaces may be part of a password) and may start with '-'
// (they reach the commands via environment variables, not flags).
function secret(input, field, err) {
  if (input[`${field}_clear`]) return null;
  const v = typeof input[field] === 'string' ? input[field] : '';
  if (v === '') return undefined;
  if (CONTROL.test(v)) err(field, 'Bevat ongeldige tekens (bijv. een regeleinde).');
  return v;
}
