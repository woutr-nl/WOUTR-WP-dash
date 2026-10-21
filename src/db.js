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
}
