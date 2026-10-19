import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { localDatabase, unusedPort } from '../local-database.mjs';
import { Ledger, databasePool, migrate } from '../ledger.mjs';
import { BetaError, POLICY, planInput, pricingHash, units } from '../policy.mjs';
import {
  configuration,
  identity,
  clientIP,
  ipQuotaIdentity,
  verifyTurnstile,
  publicFailure,
} from '../security.mjs';
import { benchmark } from '../engine.mjs';
import { fakeProvider } from '../fake-provider.mjs';
import { callProvider } from '../provider.mjs';
import { webServer } from '../server.mjs';

const nativeFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error('External network is forbidden in beta tests.');
};
const secret = randomBytes(48).toString('base64url');
const input = {
  model: 'gpt-6-astra',
  system: 'Be concise.',
  request: 'Suggest one next step for a customer with a billing problem.',
  response: '',
};
const realPlan = planInput(input).plan;
const fullPlan = {
  maxCost: 0.25,
  calls: [
    { model: 'gpt-6-astra', maxCost: 0.15 },
    { model: 'gpt-6.1-sol', maxCost: 0.09 },
    { model: 'gpt-6-luna', maxCost: 0.01 },
  ],
};
let directory, db, pool, ledger, config;
const row = async (id) => (await pool.query('SELECT * FROM beta_runs WHERE id=$1', [id])).rows[0];
const args = (plan = fullPlan) => ({
  id: randomUUID(),
  owner: randomUUID(),
  visitorHash: randomUUID(),
  ipHash: randomUUID(),
  bodyHash: randomUUID(),
  plan,
});
const denied = (code) => (error) => error.code === code;
async function admitted(plan = realPlan) {
  const a = args(plan);
  return { a, reservation: await ledger.reserve(a) };
}
async function execute(options = {}) {
  const { reservation } = await admitted();
  return {
    reservation,
    result: await benchmark({
      ledger,
      reservation,
      input,
      plan: realPlan,
      provider: fakeProvider({ delayMs: 0 }),
      ...options,
    }),
  };
}
before(async () => {
  process.umask(0o077);
  const parent = fileURLToPath(new URL('../../.cache/', import.meta.url));
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(`${parent}beta-test-`);
  db = await localDatabase({
    directory,
    password: randomBytes(24).toString('hex'),
    port: await unusedPort(),
  });
  config = configuration({
    BETA_MODE: 'demo',
    PUBLIC_ORIGIN: 'http://127.0.0.1:5174',
    IDENTITY_SECRET: secret,
    DATABASE_URL: db.url,
    BETA_KILL_SWITCH: '0',
  });
  pool = databasePool(db.url);
  ledger = new Ledger(pool, config);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE beta_events,beta_calls,beta_runs,beta_days,beta_throttle,beta_operator_audit',
  );
  await pool.query(
    "UPDATE beta_control SET mode='unconfigured',pricing_hash=NULL,identity_hash=NULL,accounted_units=0,killed=true",
  );
  await ledger.initialize();
  await ledger.switch(false);
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await pool?.end();
  await db?.postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('migrations are idempotent; config/pricing/identity mismatch and paused startup fail closed', async () => {
  assert.equal((await migrate(pool)).changed, false);
  await assert.rejects(ledger.initialize(), denied('unavailable'));
  await assert.rejects(
    new Ledger(pool, { ...config, identityHash: 'changed' }).reserve(args()),
    denied('unavailable'),
  );
  await assert.rejects(
    new Ledger(pool, { ...config, mode: 'live' }).reserve(args()),
    denied('unavailable'),
  );
  await ledger.switch(true);
  await assert.rejects(ledger.reserve(args()), denied('paused'));
  await pool.query("UPDATE beta_control SET pricing_hash='changed'");
  await assert.rejects(ledger.status(), denied('unavailable'));
  await ledger.switch(true); // Emergency kill still works with mismatched config.
});

for (const limit of ['daily', 'lifetime'])
  test(`simultaneous workers cannot exceed ${limit} budget`, async () => {
    if (limit === 'daily')
      await pool.query(
        "INSERT INTO beta_days(day,accounted_units) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,$1)",
        [POLICY.daily - POLICY.perRun],
      );
    else
      await pool.query('UPDATE beta_control SET accounted_units=$1', [
        POLICY.lifetime - POLICY.perRun,
      ]);
    const other = new Ledger(pool, config);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? other : ledger).reserve(args())),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'budget'));
    const status = await ledger.status();
    assert.equal(status[`${limit}AccountedUsd`], limit === 'daily' ? 5 : 50);
    assert.equal(status.active.length, 1);
  });

test('concurrent reservations admit exactly two, including held uncertain runs', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, () => new Ledger(pool, config).reserve(args())),
  );
  const accepted = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.equal(accepted.length, 2);
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0.5);
  await ledger.hold(accepted[0].id, accepted[0].owner);
  await assert.rejects(ledger.reserve(args()), denied('busy'));
  assert.equal((await ledger.status()).active.length, 2);
});

test('per-run ceiling and a failed database write cannot leave a partial admission', async () => {
  await assert.rejects(ledger.reserve(args({ ...fullPlan, maxCost: 0.250001 })), denied('budget'));
  const broken = {
    ...fullPlan,
    calls: [
      { model: 'unapproved', maxCost: 0.2 },
      { model: 'gpt-6-luna', maxCost: 0.05 },
    ],
  };
  await assert.rejects(ledger.reserve(args(broken)), denied('unavailable'));
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM beta_runs')).rows[0].n, 0);
});

test('duplicate submissions race atomically, never reserve twice, and survive worker replacement', async () => {
  const a = args();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      new Ledger(pool, config).reserve({ ...a, owner: randomUUID() }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert(
    results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'duplicate'),
  );
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0.25);
  await assert.rejects(ledger.reserve({ ...a, visitorHash: 'different' }), denied('conflict'));
  await assert.rejects(ledger.reserve({ ...a, bodyHash: 'different' }), denied('conflict'));
  const saved = await row(a.id);
  await ledger.settle(a.id, saved.owner);
  await assert.rejects(
    new Ledger(pool, config).duplicate(a.id, a.visitorHash, a.bodyHash),
    denied('duplicate'),
  );
});

test('three admissions per visitor and per network persist even for zero-cost stops', async () => {
  const visitor = 'same-browser',
    ip = 'same-network';
  for (let i = 0; i < 3; i++) {
    const a = { ...args(), visitorHash: visitor, ipHash: ip };
    await ledger.reserve(a);
    await ledger.settle(a.id, a.owner);
  }
  await assert.rejects(ledger.reserve({ ...args(), visitorHash: visitor }), denied('quota'));
  await assert.rejects(ledger.reserve({ ...args(), ipHash: ip }), denied('quota'));
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0);
});

test('quota admission races cannot produce a fourth visitor admission', async () => {
  for (let i = 0; i < 2; i++) {
    const a = { ...args(), visitorHash: 'visitor' };
    await ledger.reserve(a);
    await ledger.settle(a.id, a.owner);
  }
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => ledger.reserve({ ...args(), visitorHash: 'visitor' })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('IP throttle uses persistent atomic counters and rejected attempts still count', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () => ledger.throttle('one-ip')),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 30);
  assert.equal((await pool.query('SELECT count FROM beta_throttle')).rows[0].count, 40);
});

test('settlement uses measured costs and simultaneous settlements never double refund', async () => {
  const { a, reservation } = await admitted();
  const result = await benchmark({
    ledger,
    reservation,
    input,
    plan: realPlan,
    provider: fakeProvider({ delayMs: 0 }),
  });
  assert.deepEqual(
    result.candidates.map((c) => c.model),
    ['gpt-6.1-sol', 'gpt-6-luna'],
  );
  assert(result.measuredBenchmarkCost < realPlan.maxCost);
  const expected = result.measured.reduce((sum, c) => sum + units(c.cost), 0);
  assert.equal(Number((await row(a.id)).accounted_units), expected);
  await Promise.all([ledger.settle(a.id, a.owner), ledger.settle(a.id, a.owner)]);
  assert.equal((await ledger.status()).lifetimeAccountedUsd, expected / 1e9);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM beta_events WHERE name='benchmark_completion'"))
      .rows[0].n,
    1,
  );
});

test('Sol baseline makes two calls; model settings and request content are identical', async () => {
  const solInput = { ...input, model: 'gpt-6.1-sol' };
  const plan = planInput(solInput).plan;
  const { reservation } = await admitted(plan);
  const calls = [];
  const result = await benchmark({
    ledger,
    reservation,
    input: solInput,
    plan,
    provider: async (a) => {
      calls.push(a);
      return fakeProvider({ delayMs: 0 })(a);
    },
  });
  assert.deepEqual(
    calls.map((c) => c.model),
    ['gpt-6.1-sol', 'gpt-6-luna'],
  );
  assert(calls.every((c) => c.input === solInput));
  assert.deepEqual(result.measured[0].settings, result.measured[1].settings);
  assert.equal(result.measured[0].settings.reasoning.effort, 'medium');
});

test('incomplete baseline stops, settles only known cost, and never calls candidates', async () => {
  const { reservation } = await admitted();
  let calls = 0;
  await assert.rejects(
    benchmark({
      ledger,
      reservation,
      input,
      plan: realPlan,
      provider: async (a) => {
        calls++;
        return { ...(await fakeProvider({ delayMs: 0 })(a)), complete: false };
      },
    }),
    denied('incomplete'),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'settled');
  assert((await ledger.status()).lifetimeAccountedUsd < realPlan.maxCost);
});

test('incomplete candidate is excluded; following candidate remains eligible', async () => {
  const { result } = await execute({
    provider: async (a) => ({
      ...(await fakeProvider({ delayMs: 0 })(a)),
      complete: a.model !== 'gpt-6.1-sol',
    }),
  });
  assert.deepEqual(
    result.candidates.map((c) => c.model),
    ['gpt-6-luna'],
  );
  assert.equal(result.failures.length, 1);
});

for (const code of [
  'timeout',
  'provider_error',
  'rate_limit',
  'quota',
  'unsupported_pricing',
  'missing_usage',
  'incomparable_settings',
])
  test(`${code} stops after one attempt and retains full uncertain reservation`, async () => {
    const { reservation } = await admitted();
    let calls = 0;
    await assert.rejects(
      benchmark({
        ledger,
        reservation,
        input,
        plan: realPlan,
        provider: async () => {
          calls++;
          throw Object.assign(new Error('PRIVATE provider details'), { code });
        },
      }),
    );
    assert.equal(calls, 1);
    const saved = await row(reservation.id);
    assert.equal(saved.state, 'uncertain');
    assert.equal(saved.accounted_units, saved.reserved_units);
    await assert.rejects(ledger.settle(reservation.id, reservation.owner), denied('unavailable'));
    if (!['timeout', 'provider_error'].includes(code))
      assert.equal((await ledger.status()).killed, true);
  });

for (const kind of ['wrong_cost', 'over_output_cap', 'over_input_bound', 'invalid_usage'])
  test(`unexpected ${kind} holds spending and trips kill switch`, async () => {
    const { reservation } = await admitted();
    let calls = 0;
    await assert.rejects(
      benchmark({
        ledger,
        reservation,
        input,
        plan: realPlan,
        provider: async (a) => {
          calls++;
          const result = await fakeProvider({ delayMs: 0 })(a);
          if (kind === 'wrong_cost') result.cost = 5;
          if (kind === 'over_output_cap') result.usage.outputTokens = 2049;
          if (kind === 'over_input_bound') result.usage.inputTokens = realPlan.inputTokenBound + 1;
          if (kind === 'invalid_usage') result.usage.reasoningTokens = -1;
          return result;
        },
      }),
      denied('pricing'),
    );
    assert.equal(calls, 1);
    assert.equal((await ledger.status()).killed, true);
    assert.equal((await row(reservation.id)).state, 'uncertain');
  });

test('kill switch between calls prevents another provider call', async () => {
  const { reservation } = await admitted();
  let calls = 0;
  await assert.rejects(
    benchmark({
      ledger,
      reservation,
      input,
      plan: realPlan,
      provider: async (a) => {
        calls++;
        const result = await fakeProvider({ delayMs: 0 })(a);
        await ledger.switch(true);
        return result;
      },
    }),
    denied('paused'),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'settled');
});

test('kill switch during an unresponsive provider call aborts and holds reservation', async () => {
  const { reservation } = await admitted();
  let calls = 0;
  await assert.rejects(
    benchmark({
      ledger,
      reservation,
      input,
      plan: realPlan,
      guardIntervalMs: 5,
      provider: async () => {
        calls++;
        await ledger.switch(true);
        return new Promise(() => {});
      },
    }),
    denied('paused'),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'uncertain');
});

test('client disconnect holds dispatched spending; no provider retry', async () => {
  const { reservation } = await admitted();
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    benchmark({
      ledger,
      reservation,
      input,
      plan: realPlan,
      signal: controller.signal,
      provider: async () => {
        calls++;
        controller.abort();
        return new Promise(() => {});
      },
    }),
    denied('cancelled'),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'uncertain');
});

test('worker process crash after dispatch preserves reservation across replacement workers', async () => {
  const a = args();
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {Ledger,databasePool} from './beta/ledger.mjs';
    const pool=databasePool(process.env.TEST_DATABASE_URL);
    const ledger=new Ledger(pool,JSON.parse(process.env.TEST_LEDGER_CONFIG));
    const a=JSON.parse(process.env.TEST_ADMISSION);
    await ledger.reserve(a);await ledger.dispatch(a.id,a.owner,0);process.exit(77);
  `,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        TEST_DATABASE_URL: db.url,
        TEST_LEDGER_CONFIG: JSON.stringify({
          mode: config.mode,
          identityHash: config.identityHash,
        }),
        TEST_ADMISSION: JSON.stringify(a),
      },
    },
  );
  assert.equal((await once(child, 'exit'))[0], 77);
  const replacement = new Ledger(pool, config);
  assert.equal((await row(a.id)).state, 'running');
  assert.equal((await replacement.status()).lifetimeAccountedUsd, 0.25);
  await assert.rejects(replacement.dispatch(a.id, a.owner, 0), denied('cancelled'));
  await assert.rejects(replacement.settle(a.id, a.owner), denied('unavailable'));
  await assert.rejects(replacement.reserve(a), denied('duplicate'));
});

test('manual recovery requires paused service and old workers stopped; full reservation remains consumed', async () => {
  const { reservation } = await admitted();
  await ledger.dispatch(reservation.id, reservation.owner, 0);
  await ledger.hold(reservation.id, reservation.owner);
  await assert.rejects(ledger.closeUncertain(reservation.id), denied('paused'));
  await ledger.switch(true);
  await assert.rejects(ledger.closeUncertain(reservation.id), denied('unavailable'));
  await pool.query(
    "UPDATE beta_runs SET updated_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",
    [reservation.id],
  );
  await ledger.closeUncertain(reservation.id);
  assert.equal((await ledger.status()).active.length, 0);
  assert.equal((await ledger.status()).lifetimeAccountedUsd, units(realPlan.maxCost) / 1e9);
  await assert.rejects(ledger.dispatch(reservation.id, reservation.owner, 1));
});

test('ambiguous reservation COMMIT acknowledgement never leads to provider dispatch', async () => {
  const uncertainPool = {
    connect: async () => {
      const c = await pool.connect();
      return {
        release: (...a) => c.release(...a),
        query: async (sql, ...rest) => {
          const result = await c.query(sql, ...rest);
          if (sql === 'COMMIT') throw new Error('lost acknowledgement');
          return result;
        },
      };
    },
  };
  const a = args();
  await assert.rejects(new Ledger(uncertainPool, config).reserve(a), denied('unavailable'));
  assert.equal((await row(a.id)).state, 'reserved');
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0.25);
  assert(
    (await pool.query('SELECT state FROM beta_calls WHERE run_id=$1', [a.id])).rows.every(
      (c) => c.state === 'planned',
    ),
  );
});

test('usage checkpoint failure holds full reservation, even when write actually committed', async () => {
  const { reservation } = await admitted();
  const faulty = Object.create(ledger);
  let calls = 0;
  faulty.recordCall = async (...a) => {
    await ledger.recordCall(...a);
    throw new BetaError('unavailable');
  };
  await assert.rejects(
    benchmark({
      ledger: faulty,
      reservation,
      input,
      plan: realPlan,
      provider: async (a) => {
        calls++;
        return fakeProvider({ delayMs: 0 })(a);
      },
    }),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'uncertain');
  assert.equal((await ledger.status()).lifetimeAccountedUsd, realPlan.maxCost);
});

test('ambiguous settlement acknowledgement cannot refund a second time', async () => {
  const { reservation } = await admitted();
  const faulty = Object.create(ledger);
  let calls = 0;
  faulty.settle = async (...a) => {
    await ledger.settle(...a);
    throw new BetaError('unavailable');
  };
  await assert.rejects(
    benchmark({
      ledger: faulty,
      reservation,
      input,
      plan: realPlan,
      provider: async (a) => {
        calls++;
        return fakeProvider({ delayMs: 0 })(a);
      },
    }),
  );
  assert.equal(calls, 3);
  const saved = await row(reservation.id);
  assert.equal(saved.state, 'settled');
  assert(Number(saved.accounted_units) > 0);
  assert.equal((await ledger.status()).lifetimeAccountedUsd, Number(saved.accounted_units) / 1e9);
});

test('database outage blocks dispatch; recovery preserves held accounting and duplicate protection', async () => {
  const { a, reservation } = await admitted();
  await ledger.dispatch(a.id, a.owner, 0);
  await db.postgres.stop();
  await assert.rejects(ledger.reserve(args()), denied('unavailable'));
  await assert.rejects(ledger.guard(a.id, a.owner), denied('unavailable'));
  await db.postgres.start();
  assert.equal((await ledger.status()).lifetimeAccountedUsd, realPlan.maxCost);
  await assert.rejects(ledger.reserve(a), denied('duplicate'));
  await assert.rejects(ledger.settle(reservation.id, reservation.owner), denied('unavailable'));
});

test('database failure during a call aborts it; a restored database does not release the reservation', async () => {
  const { reservation } = await admitted();
  const failed = Object.create(ledger);
  let calls = 0;
  failed.guard = async () => {
    throw new BetaError('unavailable');
  };
  await assert.rejects(
    benchmark({
      ledger: failed,
      reservation,
      input,
      plan: realPlan,
      guardIntervalMs: 5,
      provider: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    denied('unavailable'),
  );
  assert.equal(calls, 1);
  assert.equal((await row(reservation.id)).state, 'uncertain');
});

test('UTC rollover carries uncertain reservations and blocks continuing yesterday’s calls', async () => {
  const { a } = await admitted(fullPlan);
  await pool.query(
    "INSERT INTO beta_days(day,accounted_units) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date-1,250000000)",
  );
  await pool.query(
    "UPDATE beta_runs SET day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1 WHERE id=$1",
    [a.id],
  );
  await pool.query(
    "UPDATE beta_days SET accounted_units=$1 WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date",
    [POLICY.daily - POLICY.perRun],
  );
  await assert.rejects(ledger.dispatch(a.id, a.owner, 0), denied('cancelled'));
  await assert.rejects(ledger.reserve(args()), denied('budget'));
  assert.equal((await ledger.status()).dailyAccountedUsd, 5);
});

test('request restrictions reject unknown models, tool/settings injection, oversized input and >25¢ plans', () => {
  for (const bad of [
    { ...input, model: 'unapproved' },
    { ...input, max_output_tokens: 99999 },
    { ...input, tools: [] },
    { ...input, request: 'x'.repeat(48001) },
    { ...input, response: 'x'.repeat(100001) },
    { ...input, request: 'x'.repeat(47000) },
  ])
    assert.throws(() => planInput(bad), denied('input'));
  assert(realPlan.maxCost <= 0.25);
  assert.equal(realPlan.maxOutputTokens, 2048);
  assert.equal(realPlan.calls.length, 3);
});

test('signed visitor cookie/CSRF reject tampering and duplicate cookies; live cookie is secure', () => {
  const sessions = identity({ ...config, mode: 'live' });
  let cookie;
  const visitor = sessions.ensure(
    { headers: {} },
    {
      setHeader: (name, value) => {
        cookie = value;
      },
    },
  );
  assert.match(cookie, /__Host-abd=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /; Secure/);
  const req = { headers: { cookie: cookie.split(';')[0] } };
  assert.equal(sessions.read(req).id, visitor.id);
  req.headers['x-csrf-token'] = sessions.csrf(visitor);
  assert(sessions.validCsrf(req, visitor));
  assert.equal(
    sessions.read({ headers: { cookie: req.headers.cookie + '; ' + req.headers.cookie } }),
    null,
  );
  assert.equal(sessions.read({ headers: { cookie: req.headers.cookie.slice(0, -1) + '!' } }), null);
  assert.equal(sessions.validCsrf({ headers: { 'x-csrf-token': 'forged' } }, visitor), false);
});

test('untrusted forwarded IPs cannot reset quota; IPv6 rotations share /64', () => {
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '8.8.8.8' } };
  assert.equal(clientIP(req, config), '127.0.0.1');
  const trusted = configuration({
    BETA_MODE: 'demo',
    PUBLIC_ORIGIN: config.origin,
    IDENTITY_SECRET: secret,
    DATABASE_URL: db.url,
    BETA_KILL_SWITCH: '0',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  });
  assert.equal(clientIP(req, trusted), '8.8.8.8');
  assert.equal(
    clientIP({ ...req, headers: { 'x-forwarded-for': 'forged, 203.0.113.7' } }, trusted),
    '203.0.113.7',
  );
  assert.equal(ipQuotaIdentity('2001:db8:1:2::1'), ipQuotaIdentity('2001:db8:1:2::abcd:ef00'));
  assert.throws(
    () =>
      configuration({
        BETA_MODE: 'demo',
        PUBLIC_ORIGIN: config.origin,
        IDENTITY_SECRET: secret,
        DATABASE_URL: db.url,
        TRUSTED_PROXY_CIDRS: '0.0.0.0/0',
      }),
    denied('unavailable'),
  );
});

test('live pricing approval expires; it cannot enable with a different rate hash or missing kill-switch opt-in', () => {
  const env = {
    BETA_MODE: 'live',
    PUBLIC_ORIGIN: 'https://beta.example.com',
    IDENTITY_SECRET: secret,
    DATABASE_URL: db.url,
    OPENAI_API_KEY: 'synthetic-test-key',
    TURNSTILE_SECRET_KEY: 'synthetic-test-secret',
    TURNSTILE_SITE_KEY: 'synthetic-test-site',
    BETA_KILL_SWITCH: '0',
    PRICING_APPROVED_HASH: pricingHash,
    PRICING_APPROVED_UNTIL: new Date(Date.now() + 3600000).toISOString(),
  };
  assert(configuration(env).allowed());
  env.PRICING_APPROVED_HASH = 'changed';
  assert(!configuration(env).allowed());
  env.PRICING_APPROVED_HASH = pricingHash;
  env.PRICING_APPROVED_UNTIL = new Date(Date.now() - 1000).toISOString();
  assert(!configuration(env).allowed());
  env.PRICING_APPROVED_UNTIL = new Date(Date.now() + 8 * 86400000).toISOString();
  assert(!configuration(env).allowed());
  env.BETA_KILL_SWITCH = '1';
  assert(!configuration(env).allowed());
});

test('Turnstile validates hostname, action, age and success with one request and no retries', async () => {
  const good = {
    success: true,
    hostname: config.hostname,
    action: 'benchmark',
    challenge_ts: new Date().toISOString(),
  };
  for (const patch of [
    null,
    { success: false },
    { hostname: 'evil.example' },
    { action: 'other' },
    { challenge_ts: new Date(Date.now() - 301000).toISOString() },
    { challenge_ts: 'bad' },
  ]) {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls++;
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(options.redirect, 'error');
      return Response.json({ ...good, ...patch });
    };
    const action = verifyTurnstile('test-token', config, { fetchImpl });
    if (patch) await assert.rejects(action, denied('verification'));
    else await action;
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    verifyTurnstile('token', config, {
      fetchImpl: async () => {
        calls++;
        throw new Error(secret);
      },
    }),
    denied('verification'),
  );
  assert.equal(calls, 1);
  await assert.rejects(verifyTurnstile('x'.repeat(2049), config), denied('verification'));
});

test('provider adapter has one attempt, bounded response and sanitized transport errors', async () => {
  let calls = 0;
  await assert.rejects(
    callProvider({ model: input.model, input, apiKey: secret }, async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.redirect, 'error');
      const payload = JSON.parse(options.body);
      assert.equal(payload.max_output_tokens, 2048);
      assert.equal(payload.reasoning.effort, 'medium');
      assert.equal(payload.service_tier, 'default');
      assert.equal(payload.store, false);
      return new Response('x'.repeat(524289));
    }),
    (error) => error.code === 'provider_error' && !error.message.includes(secret),
  );
  assert.equal(calls, 1);
  assert(!JSON.stringify(publicFailure(new Error(secret))).includes(secret));
});

async function httpHarness(provider = fakeProvider({ delayMs: 0 }), verifier) {
  const port = await unusedPort();
  const c = {
    ...config,
    port,
    origin: `http://127.0.0.1:${port}`,
    apiKey: 'synthetic-server-secret-never-public',
  };
  const server = webServer({ config: c, ledger, provider, verifier, guardIntervalMs: 5 });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const response = await nativeFetch(`${c.origin}/api/config`);
  const browserConfig = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const post = (path, data, headers = {}) =>
    nativeFetch(`${c.origin}${path}`, {
      method: 'POST',
      headers: {
        Origin: c.origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': browserConfig.csrf,
        ...headers,
      },
      body: JSON.stringify(data),
    });
  return {
    c,
    server,
    browserConfig,
    cookie,
    post,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('HTTP flow streams real-shaped sample results; duplicate replay never calls the provider', async () => {
  let calls = 0;
  const app = await httpHarness(async (a) => {
    calls++;
    return fakeProvider({ delayMs: 0 })(a);
  });
  try {
    assert.equal(app.browserConfig.mode, 'demo');
    assert(!JSON.stringify(app.browserConfig).includes(app.c.apiKey));
    const payload = { input, idempotencyKey: randomUUID(), turnstileToken: 'local-demo' };
    const response = await app.post('/api/benchmark', payload);
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert.equal(events.at(-1).type, 'result');
    assert.equal(events.at(-1).result.candidates.length, 2);
    assert.equal(calls, 3);
    assert.equal((await app.post('/api/benchmark', payload)).status, 409);
    assert.equal(calls, 3);
  } finally {
    await app.close();
  }
});

test('HTTP exhausted budgets, failed Turnstile, invalid bodies and CSRF cannot trigger calls', async () => {
  let calls = 0;
  const app = await httpHarness(async () => {
    calls++;
    throw new Error('must not execute');
  });
  try {
    const payload = { input, idempotencyKey: randomUUID(), turnstileToken: 'local-demo' };
    assert.equal(
      (await app.post('/api/benchmark', { ...payload, apiKey: 'browser-supplied' })).status,
      400,
    );
    assert.equal(
      (await app.post('/api/benchmark', payload, { 'X-CSRF-Token': 'forged' })).status,
      403,
    );
    assert.equal(
      (await app.post('/api/benchmark', payload, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(
      (await app.post('/api/benchmark', { ...payload, turnstileToken: 'invalid' })).status,
      403,
    );
    assert.equal(
      (
        await app.post('/api/benchmark', {
          ...payload,
          input: { ...input, request: 'x'.repeat(180001) },
        })
      ).status,
      400,
    );
    await pool.query('UPDATE beta_control SET accounted_units=$1', [POLICY.lifetime]);
    assert.equal((await app.post('/api/benchmark', payload)).status, 429);
    assert.equal(calls, 0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM beta_runs')).rows[0].n, 0);
  } finally {
    await app.close();
  }
});

test('HTTP secret echo is redacted, private files unavailable, analytics reject content and fake server events', async () => {
  const app = await httpHarness(async (a) => ({
    ...(await fakeProvider({ delayMs: 0 })(a)),
    output: `Result ${a.apiKey} ${secret}`,
  }));
  try {
    const id = randomUUID();
    const body = await (
      await app.post('/api/benchmark', { input, idempotencyKey: id, turnstileToken: 'local-demo' })
    ).text();
    assert(!body.includes(app.c.apiKey));
    assert(!body.includes(secret));
    assert(body.includes('[redacted]'));
    for (const path of [
      '/.env',
      '/beta/environment.example',
      '/beta/ledger.mjs',
      '/internal/benchmark/fixtures.json',
      '/outputs/internal-benchmark/smb-v1/manifest.json',
    ])
      assert.equal((await nativeFetch(app.c.origin + path)).status, 404);
    for (const event of [
      { id: randomUUID(), name: 'landing_visit', prompt: input.request },
      { id: randomUUID(), name: 'benchmark_completion' },
      { id: randomUUID(), name: input.request },
    ])
      assert.equal((await app.post('/api/events', event)).status, 400);
    assert.equal(
      (
        await app.post('/api/events', {
          id: randomUUID(),
          name: 'candidate_accepted',
          runId: id,
          candidateIndex: 0,
        })
      ).status,
      200,
    );
    assert.equal(
      (await app.post('/api/events', { id: randomUUID(), name: 'pricing_interest' })).status,
      200,
    );
    const data = JSON.stringify((await pool.query('SELECT * FROM beta_events')).rows);
    assert(!data.includes(input.request));
    assert(!data.includes(app.c.apiKey));
    assert(!data.includes(secret));
    const stored = JSON.stringify((await pool.query('SELECT * FROM beta_runs')).rows);
    assert(!stored.includes(input.request));
    assert(!stored.includes(app.c.apiKey));
  } finally {
    await app.close();
  }
});

test('analytics deduplicate events and reject another visitor’s run', async () => {
  const { a, reservation } = await admitted();
  await benchmark({
    ledger,
    reservation,
    input,
    plan: realPlan,
    provider: fakeProvider({ delayMs: 0 }),
  });
  const event = { id: randomUUID(), name: 'candidate_accepted', runId: a.id, candidateIndex: 0 };
  await assert.rejects(ledger.analytics(event, 'wrong-visitor'), denied('input'));
  await ledger.analytics(event, a.visitorHash);
  await ledger.analytics({ ...event, id: randomUUID() }, a.visitorHash);
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM beta_events WHERE name='candidate_accepted'"))
      .rows[0].n,
    1,
  );
});

test('browser has no API-key input, credential persistence, remote analytics or mock claims in live mode', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert(!source.includes('apiKey'));
  assert(!source.includes('localStorage'));
  assert.match(source, /LOCAL DEMO — simulated outputs and costs/);
  assert.match(source, /No payment collected/);
  assert.match(source, /track\('candidate_accepted'/);
  assert.match(source, /track\('candidate_rejected'/);
  assert(!/sessionStorage\.setItem\([^\n]*(input|response|benchmark)/.test(source));
});
