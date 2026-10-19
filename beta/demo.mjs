import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase, unusedPort } from './local-database.mjs';
import { configuration } from './security.mjs';
import { Ledger, databasePool, migrate } from './ledger.mjs';
import { webServer } from './server.mjs';

// Ignore live DATABASE_URL/API credentials. This launcher always uses its own
// localhost-only cluster, simulated provider and clearly labeled demo UI.
process.umask(0o077);
const directory = fileURLToPath(new URL('../.cache/beta-demo/', import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const secretFile = new URL('../.cache/beta-demo/identity.local', import.meta.url);
let secret;
try {
  secret = await readFile(secretFile, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secret = randomBytes(48).toString('base64url');
  await writeFile(secretFile, secret, { flag: 'wx', mode: 0o600 });
}
const db = await localDatabase({ directory, password: secret, port: await unusedPort() });
const port = Number(process.env.DEMO_PORT ?? 5174);
const config = configuration({
  BETA_MODE: 'demo',
  PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  PORT: String(port),
  DATABASE_URL: db.url,
  IDENTITY_SECRET: secret,
  BETA_KILL_SWITCH: '0',
});
const pool = databasePool(db.url),
  ledger = new Ledger(pool, config);
await migrate(pool);
if (db.fresh) {
  await ledger.initialize();
  await ledger.switch(false);
}
await ledger.status();
const server = webServer({ config, ledger });
server.listen(port, '127.0.0.1', () =>
  console.log(
    `Local fake-provider beta: ${config.origin}\nNo paid calls. Demo accounting persists between restarts.`,
  ),
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pool.end();
  await db.postgres.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
