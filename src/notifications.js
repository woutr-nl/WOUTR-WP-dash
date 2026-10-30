// Dashboard notifications: one unresolved row per site per problem.
// Open = neither resolved nor dismissed. A dismissed row stays unresolved, so it keeps
// blocking a persisting health problem from notifying again until the check has passed.
import { pool } from './db.js';

const ACTION_LABEL = { deploy: 'Deploy', update: 'Bijwerken', live: 'Live gaan' };
const OUTCOME_LABEL = { failed: 'mislukt', interrupted: 'onderbroken' };

// Keeps created_at (the "since when") and dismissed_at; the facts stay current.
export async function notify(siteId, kind, severity, message, runId = null) {
  await pool.query(`INSERT INTO notifications (site_id, kind, severity, message, run_id) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (site_id, kind) WHERE resolved_at IS NULL
    DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, run_id = EXCLUDED.run_id`,
  [siteId, kind, severity, message, runId]);
}

export async function resolve(siteId, kind) {
  await pool.query('UPDATE notifications SET resolved_at = now() WHERE site_id = $1 AND kind = $2 AND resolved_at IS NULL', [siteId, kind]);
}

export async function dismiss(id) {
  await pool.query('UPDATE notifications SET dismissed_at = now() WHERE id = $1 AND dismissed_at IS NULL AND resolved_at IS NULL', [id]);
}

export async function openCount() {
  const { rows: [{ count }] } = await pool.query('SELECT count(*) FROM notifications WHERE resolved_at IS NULL AND dismissed_at IS NULL');
  return Number(count);
}

// A dismissed-but-unresolved row counts as closed; after 30 days it is hidden here while
// the row itself survives as the re-notify blocker.
export async function listNotifications() {
  const { rows } = await pool.query(`SELECT n.*, s.site_title FROM notifications n JOIN sites s ON s.id = n.site_id
    WHERE (n.resolved_at IS NULL AND n.dismissed_at IS NULL) OR LEAST(n.resolved_at, n.dismissed_at) > now() - interval '30 days'
    ORDER BY n.created_at DESC, n.id DESC`);
  const isOpen = (n) => !n.resolved_at && !n.dismissed_at;
  return { open: rows.filter(isOpen), closed: rows.filter((n) => !isOpen(n)) };
}

// Only resolved rows: a dismissed one must keep blocking while its problem persists, however old.
export async function purgeOld() {
  await pool.query(`DELETE FROM notifications WHERE resolved_at IS NOT NULL AND LEAST(resolved_at, dismissed_at) < now() - interval '30 days'`);
}

export async function runFinished(siteId, action, runId, status) {
  const kind = `run:${action}`;
  if (status === 'success') return resolve(siteId, kind);
  if (!OUTCOME_LABEL[status]) return;
  // A new failed run is a new event: a dismissed leftover must not swallow it.
  await pool.query('UPDATE notifications SET resolved_at = now() WHERE site_id = $1 AND kind = $2 AND resolved_at IS NULL AND dismissed_at IS NOT NULL', [siteId, kind]);
  await notify(siteId, kind, 'problem', `${ACTION_LABEL[action]} ${OUTCOME_LABEL[status]} (run #${runId})`, runId);
}

// A run still 'running' at boot was cut off by a restart.
export async function markInterruptedRuns() {
  const { rows } = await pool.query(`UPDATE runs SET status = 'interrupted', finished_at = now() WHERE status = 'running' RETURNING id, site_id, action`);
  for (const r of rows) {
    // The status is already committed: a lost notification must not stop the boot.
    try {
      await runFinished(r.site_id, r.action, r.id, 'interrupted');
    } catch (e) {
      console.error(`Melding voor run ${r.id} niet opgeslagen: ${e.message}`);
    }
  }
}
