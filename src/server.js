import config from './config.js';
import { initDb } from './db.js';
import { initRunner } from './runner.js';
import { createApp } from './app.js';

try {
  await initDb();
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
createApp().listen(config.port, () => console.log(`WOUTR-WP-dash luistert op poort ${config.port}`));
