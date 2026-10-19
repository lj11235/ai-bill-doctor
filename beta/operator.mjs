import { randomBytes } from 'node:crypto';
import { configuration } from './security.mjs';
import { databasePool, Ledger, migrate } from './ledger.mjs';
import { pricingHash } from './policy.mjs';

const [command, id, ack] = process.argv.slice(2);
let pool;
try {
  if (command === 'pricing-hash') console.log(pricingHash);
  else if (command === 'generate-identity-secret')
    console.log(randomBytes(48).toString('base64url'));
  else {
    if (
      ![
        'migrate',
        'initialize',
        'status',
        'kill',
        'resume',
        'close-uncertain',
        'analytics',
        'prune',
      ].includes(command)
    )
      throw new Error();
    const config = configuration();
    pool = databasePool(config.databaseUrl);
    const ledger = new Ledger(pool, config);
    if (command === 'migrate') console.log(await migrate(pool));
    else if (command === 'initialize') {
      await ledger.initialize();
      console.log('Initialized in paused mode.');
    } else if (command === 'status') console.log(JSON.stringify(await ledger.status(), null, 2));
    else if (command === 'kill') {
      await ledger.switch(true);
      console.log('Global kill switch enabled. In-flight charges may still occur.');
    } else if (command === 'resume') {
      if (id !== '--reviewed-config') throw new Error();
      await ledger.switch(false);
      console.log('Admissions enabled; existing holds and budgets are unchanged.');
    } else if (command === 'close-uncertain') {
      if (ack !== '--all-workers-stopped') throw new Error();
      await ledger.closeUncertain(id);
      console.log('Full reservation retained as consumed budget. Concurrency slot closed.');
    } else if (command === 'analytics') {
      console.log(
        JSON.stringify(
          (
            await pool.query(
              'SELECT day::text,name,count(*)::int AS count FROM beta_events GROUP BY day,name ORDER BY day,name',
            )
          ).rows,
          null,
          2,
        ),
      );
    } else {
      await pool.query(
        "DELETE FROM beta_events WHERE day < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - 30",
      );
      await pool.query(
        'DELETE FROM beta_throttle WHERE bucket < floor(extract(epoch from clock_timestamp())/60)-10080',
      );
      console.log('Expired analytics/throttle data pruned. Financial records retained.');
    }
  }
} catch {
  console.error(
    'Operator command failed safely. No budget reset or uncertain refund was performed. See beta/OPERATIONS.md.',
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
