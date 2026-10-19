// Development only. Production uses a separately managed, persistent Postgres.
import EmbeddedPostgres from 'embedded-postgres';
import { createServer } from 'node:net';
import { mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

export async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function localDatabase({ directory, password, port }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const databaseDir = join(directory, 'postgres');
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'beta_local',
    password,
    authMethod: 'scram-sha-256',
    persistent: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    postgresFlags: [
      '-c',
      'listen_addresses=127.0.0.1',
      '-c',
      'unix_socket_directories=',
      '-c',
      'log_statement=none',
      '-c',
      'log_min_error_statement=panic',
      '-c',
      'log_parameter_max_length_on_error=0',
    ],
    onLog: () => {},
    onError: () => {},
  });
  let fresh = false;
  try {
    await access(join(databaseDir, 'PG_VERSION'));
  } catch {
    await postgres.initialise();
    fresh = true;
  }
  await postgres.start();
  return {
    postgres,
    fresh,
    url: `postgresql://beta_local:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`,
  };
}
