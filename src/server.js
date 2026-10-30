import config from './config.js';
import { initDb } from './db.js';
import { initRunner } from './runner.js';
import { initSshKey } from './sshkey.js';
import { createApp } from './app.js';
import { markInterruptedRuns } from './notifications.js';
import { initHealth } from './health.js';

try {
  await initDb();
  await markInterruptedRuns();
} catch (e) {
  console.error(`Database niet bereikbaar: ${e.message}`);
  process.exit(1);
}
try {
  await initRunner();
} catch (e) {
  console.error(`Run-omgeving (SSH/WOUTR-WP) niet in te richten: ${e.message}`);
  process.exit(1);
}
try {
  await initSshKey();
} catch (e) {
  // Only our own messages name a cause; never print key material.
  console.error(e.startup ? e.message : 'SSH-sleutel niet in te richten (aanmaken of opslaan mislukt).');
  process.exit(1);
}
createApp().listen(config.port, () => console.log(`WOUTR-WP-dash luistert op poort ${config.port}`));
initHealth();
