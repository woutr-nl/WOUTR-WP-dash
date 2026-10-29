import pg from 'pg';
import config from './config.js';

export const pool = new pg.Pool({ ...config.pg, password: config.postgresPassword });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id              serial PRIMARY KEY,
      client_slug     text NOT NULL,
      theme_type      text NOT NULL CHECK (theme_type IN ('block','bricks')),
      ssh_target      text NOT NULL,
      wp_path         text NOT NULL,
      site_url        text NOT NULL UNIQUE,
      site_title      text NOT NULL,
      admin_email     text NOT NULL,
      admin_user      text NOT NULL DEFAULT 'beheer',
      db_name         text,
      db_user         text,
      db_host         text NOT NULL DEFAULT 'localhost',
      db_pass_enc     text,
      smtp_host       text,
      smtp_port       integer NOT NULL DEFAULT 587,
      smtp_encryption text NOT NULL DEFAULT 'tls' CHECK (smtp_encryption IN ('none','ssl','tls')),
      smtp_user       text,
      smtp_from       text,
      smtp_from_name  text,
      smtp_pass_enc   text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS admin_pass_enc text;
    CREATE TABLE IF NOT EXISTS runs (
      id          serial PRIMARY KEY,
      site_id     integer NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      action      text NOT NULL CHECK (action IN ('deploy','update','live')),
      status      text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','success','failed','needs_confirmation','interrupted')),
      options     jsonb NOT NULL DEFAULT '{}',
      result      jsonb,
      exit_code   integer,
      log         text NOT NULL DEFAULT '',
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS runs_site_id_idx ON runs (site_id, id DESC);
    -- One active key (private_key_enc set); retired keys keep only their public half.
    CREATE TABLE IF NOT EXISTS ssh_keys (
      id              serial PRIMARY KEY,
      private_key_enc text,
      public_key      text NOT NULL,
      fingerprint     text NOT NULL,
      key_type        text NOT NULL,
      adopted         boolean NOT NULL DEFAULT false,
      created_at      timestamptz NOT NULL DEFAULT now(),
      retired_at      timestamptz
    );
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS da_username text;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS da_key_state jsonb;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS da_domain text;
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS db_create_error text;
    -- Last Let's Encrypt request: { status, at, names?, expires_at?, www_dropped?, www_error?, error? }.
    ALTER TABLE sites ADD COLUMN IF NOT EXISTS ssl_state jsonb;
    -- Single DirectAdmin reseller connection for the whole dashboard (one row, enforced).
    CREATE TABLE IF NOT EXISTS directadmin (
      id           boolean PRIMARY KEY DEFAULT true CHECK (id),
      url          text NOT NULL,
      username     text NOT NULL,
      password_enc text NOT NULL,
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    -- A run still 'running' at boot was cut off by a restart.
    UPDATE runs SET status = 'interrupted', finished_at = now() WHERE status = 'running';
  `);
}
