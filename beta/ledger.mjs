import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BetaError, POLICY, pricingHash, requireThat, units, uuid } from './policy.mjs';

export function databasePool(connectionString, extra = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    connectionTimeoutMillis: 2500,
    idleTimeoutMillis: 10000,
    query_timeout: 5000,
    application_name: 'ai-bill-doctor-beta',
    ...extra,
  });
  pool.on('error', () => {}); // Never log URLs, credentials, SQL parameters or driver errors.
  return pool;
}
export async function transaction(pool, fn) {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='3s'");
    await client.query("SET LOCAL lock_timeout='2s'");
    const value = await fn(client);
    await client.query('COMMIT');
    client.release();
    client = null;
    return value;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      client.release(true);
    }
    throw error instanceof BetaError ? error : new BetaError('unavailable');
  }
}
export async function migrate(pool) {
  const sql = readFileSync(new URL('./migrations/001_accounting.sql', import.meta.url), 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  return transaction(pool, async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(918201401)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS beta_migrations(version integer PRIMARY KEY, sha256 text NOT NULL)',
    );
    const existing = (await c.query('SELECT sha256 FROM beta_migrations WHERE version=1')).rows[0];
    if (existing) {
      requireThat(existing.sha256 === hash, 'unavailable');
      return { version: 1, changed: false };
    }
    await c.query(sql);
    await c.query('INSERT INTO beta_migrations VALUES (1,$1)', [hash]);
    return { version: 1, changed: true };
  });
}
const number = (value) => {
  const n = Number(value);
  requireThat(Number.isSafeInteger(n) && n >= 0, 'unavailable');
  return n;
};
const visitorDay = (visitor, day) => createHash('sha256').update(`${day}:${visitor}`).digest('hex');
const eventNames = [
  'landing_visit',
  'candidate_accepted',
  'candidate_rejected',
  'recommendation_copied',
  'pricing_interest',
];

export class Ledger {
  constructor(pool, { mode, identityHash, allowed = () => true }) {
    this.pool = pool;
    this.mode = mode;
    this.identityHash = identityHash;
    this.allowed = allowed;
  }
  async locked(c, { allowKilled = false } = {}) {
    const row = (await c.query('SELECT * FROM beta_control WHERE id=true FOR UPDATE')).rows[0];
    requireThat(
      row &&
        row.mode === this.mode &&
        row.pricing_hash === pricingHash &&
        row.identity_hash === this.identityHash,
      'unavailable',
    );
    if (!allowKilled) requireThat(!row.killed && this.allowed(), 'paused');
    const { day, bucket } = (
      await c.query(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day, floor(extract(epoch from clock_timestamp())/60)::bigint AS bucket",
      )
    ).rows[0];
    return { ...row, day, bucket };
  }
  async run(c, id, owner) {
    const row = (await c.query('SELECT * FROM beta_runs WHERE id=$1 FOR UPDATE', [id])).rows[0];
    requireThat(row && row.owner === owner, 'unavailable');
    return row;
  }
  async initialize() {
    return transaction(this.pool, async (c) => {
      const row = (await c.query('SELECT * FROM beta_control WHERE id=true FOR UPDATE')).rows[0];
      requireThat(row?.mode === 'unconfigured' && number(row.accounted_units) === 0, 'unavailable');
      await c.query(
        'UPDATE beta_control SET mode=$1,pricing_hash=$2,identity_hash=$3 WHERE id=true',
        [this.mode, pricingHash, this.identityHash],
      );
      await c.query("INSERT INTO beta_operator_audit(action) VALUES ('initialize')");
    });
  }
  async switch(killed) {
    return transaction(this.pool, async (c) => {
      // Kill works even if the app's identity/pricing config is wrong.
      if (!killed) {
        await this.locked(c, { allowKilled: true });
        requireThat(this.allowed(), 'paused');
      }
      await c.query(
        'UPDATE beta_control SET killed=$1,updated_at=clock_timestamp() WHERE id=true',
        [killed],
      );
      await c.query('INSERT INTO beta_operator_audit(action) VALUES ($1)', [
        killed ? 'kill' : 'resume',
      ]);
    });
  }
  async throttle(ipHash) {
    return transaction(this.pool, async (c) => {
      const clock = await this.locked(c, { allowKilled: true });
      const row = (
        await c.query(
          `INSERT INTO beta_throttle(ip_hash,bucket,count) VALUES ($1,$2,1)
        ON CONFLICT(ip_hash,bucket) DO UPDATE SET count=beta_throttle.count+1 RETURNING count`,
          [ipHash, clock.bucket],
        )
      ).rows[0];
      // Commit even rejected attempts so a busy attacker cannot reset the counter.
      return row.count <= POLICY.requestsPerMinute;
    }).then((ok) => requireThat(ok, 'throttle'));
  }
  async duplicate(id, visitorHash, bodyHash) {
    requireThat(uuid(id));
    return transaction(this.pool, async (c) => {
      await this.locked(c);
      const row = (await c.query('SELECT visitor_hash,body_hash FROM beta_runs WHERE id=$1', [id]))
        .rows[0];
      if (row)
        throw new BetaError(
          row.visitor_hash === visitorHash && row.body_hash === bodyHash ? 'duplicate' : 'conflict',
        );
    });
  }
  async reserve({ id, owner, visitorHash, ipHash, bodyHash, plan }) {
    requireThat(uuid(id) && uuid(owner));
    const reserved = units(plan.maxCost);
    requireThat(
      reserved > 0 && reserved <= POLICY.perRun && plan.calls.length >= 2 && plan.calls.length <= 3,
      'budget',
    );
    requireThat(plan.calls.reduce((n, call) => n + units(call.maxCost), 0) <= reserved, 'budget');
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c);
      const old = (await c.query('SELECT visitor_hash,body_hash FROM beta_runs WHERE id=$1', [id]))
        .rows[0];
      if (old)
        throw new BetaError(
          old.visitor_hash === visitorHash && old.body_hash === bodyHash ? 'duplicate' : 'conflict',
        );
      const active = (
        await c.query(
          "SELECT count(*)::int AS count, coalesce(sum(accounted_units) FILTER(WHERE day < $1::date),0)::bigint AS carry FROM beta_runs WHERE state <> 'settled'",
          [control.day],
        )
      ).rows[0];
      requireThat(active.count < POLICY.concurrency, 'busy');
      const quota = (
        await c.query(
          `SELECT count(*) FILTER(WHERE visitor_hash=$1)::int AS visitor,
        count(*) FILTER(WHERE ip_hash=$2)::int AS ip FROM beta_runs WHERE day=$3::date AND (visitor_hash=$1 OR ip_hash=$2)`,
          [visitorHash, ipHash, control.day],
        )
      ).rows[0];
      requireThat(quota.visitor < POLICY.visitorDaily && quota.ip < POLICY.ipDaily, 'quota');
      await c.query('INSERT INTO beta_days(day) VALUES ($1) ON CONFLICT DO NOTHING', [control.day]);
      const daily = (
        await c.query('SELECT accounted_units FROM beta_days WHERE day=$1 FOR UPDATE', [
          control.day,
        ])
      ).rows[0];
      requireThat(
        number(control.accounted_units) + reserved <= POLICY.lifetime &&
          number(daily.accounted_units) + number(active.carry) + reserved <= POLICY.daily,
        'budget',
      );
      await c.query('UPDATE beta_control SET accounted_units=accounted_units+$1 WHERE id=true', [
        reserved,
      ]);
      await c.query('UPDATE beta_days SET accounted_units=accounted_units+$2 WHERE day=$1', [
        control.day,
        reserved,
      ]);
      await c.query(
        `INSERT INTO beta_runs(id,owner,visitor_hash,ip_hash,body_hash,day,reserved_units,accounted_units,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,'reserved')`,
        [id, owner, visitorHash, ipHash, bodyHash, control.day, reserved],
      );
      for (const [i, call] of plan.calls.entries())
        await c.query(
          'INSERT INTO beta_calls(run_id,ordinal,model,bound_units) VALUES($1,$2,$3,$4)',
          [id, i, call.model, units(call.maxCost)],
        );
      await this.event(c, {
        id: randomUUID(),
        day: control.day,
        visitor: visitorHash,
        name: 'benchmark_start',
        runId: id,
      });
      return { id, owner, day: control.day, reservedUnits: reserved };
    });
  }
  async dispatch(id, owner, ordinal) {
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c);
      const run = await this.run(c, id, owner);
      requireThat(['reserved', 'running'].includes(run.state), 'cancelled');
      // No calls continue into a new UTC budget day or after a stalled worker resumes.
      const age = (
        await c.query(
          'SELECT extract(epoch from clock_timestamp()-created_at)*1000 AS age, day::text AS day FROM beta_runs WHERE id=$1',
          [id],
        )
      ).rows[0];
      requireThat(age.day === control.day && Number(age.age) < POLICY.runTimeoutMs, 'cancelled');
      const calls = (
        await c.query('SELECT * FROM beta_calls WHERE run_id=$1 ORDER BY ordinal', [id])
      ).rows;
      requireThat(
        calls[ordinal]?.state === 'planned' &&
          calls.slice(0, ordinal).every((call) => call.state === 'known') &&
          calls.slice(ordinal + 1).every((call) => call.state === 'planned'),
        'cancelled',
      );
      await c.query("UPDATE beta_calls SET state='dispatched' WHERE run_id=$1 AND ordinal=$2", [
        id,
        ordinal,
      ]);
      await c.query(
        "UPDATE beta_runs SET state='running',updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
    });
  }
  async guard(id, owner) {
    return transaction(this.pool, async (c) => {
      await this.locked(c);
      const run = await this.run(c, id, owner);
      requireThat(['reserved', 'running'].includes(run.state), 'cancelled');
    });
  }
  async recordCall(id, owner, ordinal, result) {
    const cost = units(result.cost);
    return transaction(this.pool, async (c) => {
      await this.locked(c, { allowKilled: true });
      const run = await this.run(c, id, owner);
      requireThat(['running', 'reserved'].includes(run.state), 'cancelled');
      const call = (
        await c.query('SELECT * FROM beta_calls WHERE run_id=$1 AND ordinal=$2 FOR UPDATE', [
          id,
          ordinal,
        ])
      ).rows[0];
      requireThat(call?.state === 'dispatched' && cost <= number(call.bound_units), 'pricing');
      await c.query(
        "UPDATE beta_calls SET state='known',cost_units=$3,outcome=$4 WHERE run_id=$1 AND ordinal=$2",
        [id, ordinal, cost, result.complete ? 'complete' : 'incomplete'],
      );
    });
  }
  async hold(id, owner, trip = false) {
    return transaction(this.pool, async (c) => {
      await this.locked(c, { allowKilled: true });
      const run = await this.run(c, id, owner);
      if (run.state !== 'settled')
        await c.query(
          "UPDATE beta_runs SET state='uncertain',reason='requires_operator_review',updated_at=clock_timestamp() WHERE id=$1",
          [id],
        );
      if (trip)
        await c.query(
          'UPDATE beta_control SET killed=true,updated_at=clock_timestamp() WHERE id=true',
        );
    });
  }
  async settle(id, owner, { complete = false } = {}) {
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c, { allowKilled: true });
      const run = await this.run(c, id, owner);
      if (run.state === 'settled') return; // Idempotent settlement, never double release.
      requireThat(['reserved', 'running'].includes(run.state), 'unavailable');
      const calls = (
        await c.query('SELECT * FROM beta_calls WHERE run_id=$1 ORDER BY ordinal', [id])
      ).rows;
      requireThat(
        calls.every((call) => call.state !== 'dispatched'),
        'unavailable',
      );
      if (complete)
        requireThat(
          calls.every((call) => call.state === 'known'),
          'unavailable',
        );
      const total = calls.reduce(
        (n, call) => n + (call.state === 'known' ? number(call.cost_units) : 0),
        0,
      );
      requireThat(total <= number(run.reserved_units), 'pricing');
      const release = number(run.accounted_units) - total;
      await c.query('UPDATE beta_control SET accounted_units=accounted_units-$1 WHERE id=true', [
        release,
      ]);
      await c.query('UPDATE beta_days SET accounted_units=accounted_units-$2 WHERE day=$1', [
        run.day,
        release,
      ]);
      // A call crossing midnight is conservatively charged to BOTH UTC days.
      // Old uncertain reservations count as carry until explicitly reconciled.
      const day = (await c.query('SELECT day::text AS day FROM beta_runs WHERE id=$1', [id]))
        .rows[0].day;
      if (day !== control.day)
        await c.query(
          'INSERT INTO beta_days(day,accounted_units) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET accounted_units=beta_days.accounted_units+$2',
          [control.day, total],
        );
      await c.query(
        "UPDATE beta_runs SET state='settled',accounted_units=$2,reason=$3,updated_at=clock_timestamp() WHERE id=$1",
        [id, total, complete ? 'complete' : 'stopped_known_cost'],
      );
      if (complete)
        await this.event(c, {
          id: randomUUID(),
          day: control.day,
          visitor: run.visitor_hash,
          name: 'benchmark_completion',
          runId: id,
        });
    });
  }
  async event(c, { id, day, visitor, name, runId = null, candidate = null }) {
    await c.query(
      'INSERT INTO beta_events(id,day,visitor_day_hash,name,run_id,candidate_index) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [id, day, visitorDay(visitor, day), name, runId, candidate],
    );
  }
  async analytics({ id, name, runId, candidateIndex }, visitor) {
    requireThat(uuid(id) && eventNames.includes(name));
    const isRun = ['candidate_accepted', 'candidate_rejected', 'recommendation_copied'].includes(
      name,
    );
    requireThat(
      isRun
        ? uuid(runId) &&
            Number.isInteger(candidateIndex) &&
            candidateIndex >= 0 &&
            candidateIndex < 2
        : runId === undefined && candidateIndex === undefined,
    );
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c, { allowKilled: true });
      if (isRun) {
        const run = (await c.query('SELECT visitor_hash,state FROM beta_runs WHERE id=$1', [runId]))
          .rows[0];
        requireThat(run?.visitor_hash === visitor && run.state === 'settled');
        const call = (
          await c.query(
            "SELECT 1 FROM beta_calls WHERE run_id=$1 AND ordinal=$2 AND outcome='complete'",
            [runId, candidateIndex + 1],
          )
        ).rows[0];
        requireThat(call);
      }
      await this.event(c, {
        id,
        day: control.day,
        visitor,
        name,
        runId,
        candidate: candidateIndex,
      });
    });
  }
  async status() {
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c, { allowKilled: true });
      const daily = (
        await c.query('SELECT accounted_units FROM beta_days WHERE day=$1', [control.day])
      ).rows[0];
      const active = (
        await c.query(
          "SELECT id,state,reserved_units,created_at,updated_at,day::text AS day FROM beta_runs WHERE state<>'settled' ORDER BY created_at",
        )
      ).rows;
      return {
        mode: control.mode,
        killed: control.killed,
        day: control.day,
        lifetimeAccountedUsd: number(control.accounted_units) / 1e9,
        dailyAccountedUsd:
          (number(daily?.accounted_units ?? 0) +
            active
              .filter((r) => r.day < control.day)
              .reduce((n, r) => n + number(r.reserved_units), 0)) /
          1e9,
        active: active.map((r) => ({
          id: r.id,
          state: r.state,
          reservedUsd: number(r.reserved_units) / 1e9,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        })),
      };
    });
  }
  async closeUncertain(id) {
    requireThat(uuid(id));
    return transaction(this.pool, async (c) => {
      const control = await this.locked(c, { allowKilled: true });
      requireThat(control.killed, 'paused');
      const run = (
        await c.query(
          'SELECT *,day::text AS day_text, extract(epoch from clock_timestamp()-updated_at) AS age FROM beta_runs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      requireThat(run && run.state !== 'settled' && Number(run.age) >= 600, 'unavailable');
      // Operator explicitly certifies all old workers stopped. Never refund an
      // unknown charge: retain the full reserved amount as consumed beta budget.
      if (run.day_text !== control.day)
        await c.query(
          'INSERT INTO beta_days(day,accounted_units) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET accounted_units=beta_days.accounted_units+$2',
          [control.day, run.accounted_units],
        );
      await c.query(
        "UPDATE beta_runs SET state='settled',reason='operator_full_reservation_charged',updated_at=clock_timestamp() WHERE id=$1",
        [id],
      );
      await c.query("INSERT INTO beta_operator_audit(action,run_id) VALUES('close_uncertain',$1)", [
        id,
      ]);
    });
  }
}
