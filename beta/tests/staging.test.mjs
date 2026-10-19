import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { Ledger, databasePool, migrate } from "../ledger.mjs";
import { configuration, keyedHash, ipQuotaIdentity } from "../security.mjs";
import { planInput, pricingHash } from "../policy.mjs";
import { localDatabase, unusedPort } from "../local-database.mjs";

// No existing database, credentials or experiment records are used.
const originalFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("External network forbidden in staging tests.");
};
const input = {
  model: "gpt-6-astra",
  system: "",
  request: "SYNTHETIC_PRIVATE_PROMPT_CANARY",
  response: "",
};
const plan = planInput(input).plan;
const boundaryPlan = {
  maxCost: 0.25,
  calls: [
    { model: "gpt-6-astra", maxCost: 0.15 },
    { model: "gpt-6.1-sol", maxCost: 0.09 },
    { model: "gpt-6-luna", maxCost: 0.01 },
  ],
};
const admission = (p = plan) => ({
  id: randomUUID(),
  owner: randomUUID(),
  visitorHash: randomUUID(),
  ipHash: randomUUID(),
  bodyHash: randomUUID(),
  plan: p,
});
let directory, db, pool, ledger, env;
const workers = new Set();
const seenLogs = [];
const waitFor = async (worker, type) => {
  const existing = worker.messages.findIndex(
    (message) => message.type === type,
  );
  if (existing !== -1) return worker.messages.splice(existing, 1)[0];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing ${type} from local test worker`));
    }, 55000);
    function handler(message) {
      if (message.type === type) {
        cleanup();
        worker.messages.splice(worker.messages.indexOf(message), 1);
        resolve(message);
      }
    }
    function exited() {
      cleanup();
      reject(new Error("Test worker exited unexpectedly"));
    }
    function cleanup() {
      clearTimeout(timer);
      worker.child.off("message", handler);
      worker.child.off("exit", exited);
    }
    worker.child.on("message", handler);
    worker.child.on("exit", exited);
  });
};
async function worker(extra = {}) {
  const child = fork(
    fileURLToPath(new URL("./fixtures/staging-worker.mjs", import.meta.url)),
    [],
    {
      env: { PATH: process.env.PATH, ...env, ...extra },
      silent: true,
    },
  );
  const w = { child, messages: [] };
  child.on("message", (message) => {
    w.messages.push(message);
    if (message.type === "captured-log") seenLogs.push(message.text);
  });
  child.stdout.on("data", (data) => seenLogs.push(data.toString()));
  child.stderr.on("data", (data) => seenLogs.push(data.toString()));
  workers.add(w);
  await waitFor(w, "ready");
  return w;
}
async function stop(w, signal) {
  if (w.child.exitCode !== null || w.child.signalCode !== null) return;
  const exited = once(w.child, "exit");
  if (signal) w.child.kill(signal);
  else w.child.send({ action: "stop" });
  await exited;
}
async function operator(...args) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../operator.mjs", import.meta.url)), ...args],
    {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
      seenLogs.push(data.toString());
    });
  const [code] = await once(child, "exit");
  return { code, output };
}
async function enable() {
  env.BETA_KILL_SWITCH = "0";
  await ledger.switch(false);
}
const runRow = async (id) =>
  (await pool.query("SELECT * FROM beta_runs WHERE id=$1", [id])).rows[0];

before(async () => {
  process.umask(0o077);
  const cache = fileURLToPath(new URL("../../.cache/", import.meta.url));
  await mkdir(cache, { recursive: true });
  directory = await mkdtemp(`${cache}staging-test-`);
  db = await localDatabase({
    directory,
    password: randomBytes(24).toString("hex"),
    port: await unusedPort(),
  });
  env = {
    BETA_MODE: "live",
    PUBLIC_ORIGIN: "https://staging.invalid",
    PORT: String(await unusedPort()),
    DATABASE_URL: db.url,
    IDENTITY_SECRET: randomBytes(48).toString("base64url"),
    OPENAI_API_KEY: "synthetic-staging-key-not-a-credential",
    TURNSTILE_SECRET_KEY: "synthetic-turnstile-secret",
    TURNSTILE_SITE_KEY: "synthetic-turnstile-site",
    BETA_KILL_SWITCH: "1",
    PRICING_APPROVED_HASH: pricingHash,
    PRICING_APPROVED_UNTIL: new Date(Date.now() + 3600000).toISOString(),
  };
  pool = databasePool(db.url);
  ledger = new Ledger(pool, configuration(env));
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE beta_events,beta_calls,beta_runs,beta_days,beta_throttle,beta_operator_audit",
  );
  await pool.query(
    "UPDATE beta_control SET mode='unconfigured',pricing_hash=NULL,identity_hash=NULL,accounted_units=0,killed=true",
  );
  env.BETA_KILL_SWITCH = "1";
  seenLogs.length = 0;
  await ledger.initialize();
});
afterEach(async () => {
  await ledger.switch(true);
  env.BETA_KILL_SWITCH = "1";
  for (const w of workers) await stop(w, "SIGKILL");
  workers.clear();
  assert.equal((await ledger.status()).killed, true);
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool?.end();
  await db?.postgres.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("staging: real Postgres durability settings and paused initialization", async () => {
  for (const setting of ["fsync", "synchronous_commit", "full_page_writes"])
    assert.equal((await pool.query(`SHOW ${setting}`)).rows[0][setting], "on");
  const a = admission();
  const w = await worker();
  w.child.send({ action: "reserve", args: a });
  assert.equal((await waitFor(w, "result")).code, "paused");
  assert.equal((await ledger.status()).lifetimeAccountedUsd, 0);
  assert.equal((await operator("resume", "--reviewed-config")).code, 1);
});

for (const kind of ["daily", "lifetime", "concurrency"])
  test(`staging: separate worker processes race the ${kind} boundary`, async () => {
    await enable();
    if (kind === "daily")
      await pool.query(
        "INSERT INTO beta_days(day,accounted_units) VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,4750000000)",
      );
    if (kind === "lifetime")
      await pool.query("UPDATE beta_control SET accounted_units=49750000000");
    const group = await Promise.all(Array.from({ length: 4 }, () => worker()));
    const results = group.map((w) => waitFor(w, "result"));
    for (const w of group)
      w.child.send({ action: "reserve", args: admission(boundaryPlan) });
    const done = await Promise.all(results);
    assert.equal(
      done.filter((r) => r.reservation).length,
      kind === "concurrency" ? 2 : 1,
    );
    assert(
      done
        .filter((r) => r.code)
        .every((r) => r.code === (kind === "concurrency" ? "busy" : "budget")),
    );
    const status = await ledger.status();
    assert.equal(
      kind === "lifetime"
        ? status.lifetimeAccountedUsd
        : status.dailyAccountedUsd,
      kind === "lifetime" ? 50 : kind === "daily" ? 5 : 0.5,
    );
  });

test("staging: shared operator kill aborts an active worker and blocks further dispatch", async () => {
  await enable();
  const a = admission();
  const w = await worker({ TEST_PROVIDER: "wait" });
  w.child.send({ action: "benchmark", args: a, input });
  await waitFor(w, "provider-called");
  assert.equal((await operator("kill")).code, 0);
  const result = await waitFor(w, "result");
  assert.equal(result.calls, 1);
  assert.equal(result.code, "paused");
  const held = await runRow(a.id);
  assert.equal(held.state, "uncertain");
  assert.equal(held.accounted_units, held.reserved_units);
  const another = await worker();
  another.child.send({ action: "reserve", args: admission() });
  assert.equal((await waitFor(another, "result")).code, "paused");
});

for (const signal of ["SIGKILL", "SIGTERM"])
  test(`staging: ${signal} preserves a dispatched hold; operator recovery retains the full amount`, async () => {
    await enable();
    const a = admission();
    const w = await worker({ TEST_PROVIDER: "wait" });
    w.child.send({ action: "benchmark", args: a, input });
    await waitFor(w, "provider-called");
    const reserved = Number((await runRow(a.id)).reserved_units) / 1e9;
    assert(reserved >= plan.maxCost && reserved - plan.maxCost < 1.1e-9);
    await stop(w, signal);
    assert.equal((await runRow(a.id)).state, "running");
    assert.equal((await ledger.status()).lifetimeAccountedUsd, reserved);
    await assert.rejects(ledger.settle(a.id, a.owner));
    assert.equal((await operator("kill")).code, 0);
    assert.equal(
      (await operator("close-uncertain", a.id, "--all-workers-stopped")).code,
      1,
    );
    // Advance only the isolated test row's age; never relax production recovery.
    await pool.query(
      "UPDATE beta_runs SET updated_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",
      [a.id],
    );
    assert.equal((await operator("close-uncertain", a.id)).code, 1);
    assert.equal(
      (await operator("close-uncertain", a.id, "--all-workers-stopped")).code,
      0,
    );
    const saved = await runRow(a.id);
    assert.equal(saved.reason, "operator_full_reservation_charged");
    assert.equal(saved.accounted_units, saved.reserved_units);
    assert.equal((await ledger.status()).active.length, 0);
    assert.equal((await ledger.status()).lifetimeAccountedUsd, reserved);
  });

test(
  "staging: actual 45-second provider timeout keeps one attempted call and its full reservation",
  { timeout: 55000 },
  async () => {
    await enable();
    const a = admission();
    const w = await worker({ TEST_PROVIDER: "timeout" });
    const started = Date.now();
    w.child.send({ action: "benchmark", args: a, input });
    await waitFor(w, "provider-called");
    const result = await waitFor(w, "result");
    assert(Date.now() - started >= 44000);
    assert.equal(result.calls, 1);
    const saved = await runRow(a.id);
    assert.equal(saved.state, "uncertain");
    assert.equal(saved.accounted_units, saved.reserved_units);
  },
);

function http(port, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: "staging.invalid", ...headers },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
async function proxy(backendPort) {
  const logs = [];
  const server = createServer((incoming, outgoing) => {
    // A real TCP proxy fixture: replace all client-supplied forwarding claims.
    const headers = {
      ...incoming.headers,
      "x-forwarded-for": incoming.socket.remoteAddress,
    };
    delete headers["x-forwarded-host"];
    delete headers.forwarded;
    const upstream = request(
      {
        host: "127.0.0.1",
        port: backendPort,
        path: incoming.url,
        method: incoming.method,
        headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
        logs.push({ method: incoming.method, status: response.statusCode });
      },
    );
    upstream.on("error", () => outgoing.end());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    logs,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("staging: proxy Host rejection and X-Forwarded-For spoofing cannot bypass the network quota", async () => {
  await enable();
  const w = await worker({
    TEST_HTTP: "1",
    TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
  });
  const edge = await proxy(Number(env.PORT));
  try {
    assert.equal(
      (
        await http(edge.port, "/healthz", {
          headers: { Host: "wrong.invalid" },
        })
      ).status,
      403,
    );
    for (let i = 0; i < 4; i++) {
      const cfg = await http(edge.port, "/api/config");
      const csrf = JSON.parse(cfg.text).csrf;
      const cookie = cfg.headers["set-cookie"][0].split(";")[0];
      const res = await http(edge.port, "/api/benchmark", {
        method: "POST",
        headers: {
          Origin: env.PUBLIC_ORIGIN,
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          "Content-Type": "application/json",
          "X-Forwarded-For": `198.51.100.${i + 1}`,
          "X-Forwarded-Host": "forged.invalid",
          Forwarded: "for=203.0.113.20;host=forged.invalid",
        },
        body: JSON.stringify({
          input,
          idempotencyKey: randomUUID(),
          turnstileToken: "synthetic",
        }),
      });
      assert.equal(res.status, i < 3 ? 200 : 429);
      if (i < 3)
        assert.equal(
          JSON.parse(res.text.trim().split("\n").at(-1)).type,
          "result",
        );
    }
    const rows = (await pool.query("SELECT ip_hash FROM beta_runs")).rows;
    assert.equal(rows.length, 3);
    const expected = keyedHash(
      env.IDENTITY_SECRET,
      "ip",
      ipQuotaIdentity("127.0.0.1"),
    );
    assert(rows.every((row) => row.ip_hash === expected));
    assert.equal(
      w.messages.filter((m) => m.type === "provider-called").length,
      9,
    );
  } finally {
    await edge.close();
  }
});

for (const outcome of ["success", "error"])
  test(`staging: ${outcome} prompt/output/secret canaries are absent from logs and accounting`, async () => {
    await enable();
    const output = "SYNTHETIC_PRIVATE_OUTPUT_CANARY";
    const w = await worker({
      TEST_HTTP: "1",
      TEST_OUTPUT: output,
      TEST_PROVIDER: outcome,
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    });
    const edge = await proxy(Number(env.PORT));
    try {
      const cfg = await http(edge.port, "/api/config");
      const cookie = cfg.headers["set-cookie"][0].split(";")[0];
      const csrf = JSON.parse(cfg.text).csrf;
      const headers = {
        Origin: env.PUBLIC_ORIGIN,
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      };
      const response = await http(edge.port, "/api/benchmark", {
        method: "POST",
        headers,
        body: JSON.stringify({
          input,
          idempotencyKey: randomUUID(),
          turnstileToken: "synthetic",
        }),
      });
      assert.equal(response.status, 200);
      const last = JSON.parse(response.text.trim().split("\n").at(-1));
      assert.equal(last.type, outcome === "success" ? "result" : "error");
      if (outcome === "success") assert(response.text.includes(output));
      else {
        assert.equal(last.error.code, "provider");
        assert(!response.text.includes(input.request));
      }
      const invalidEvent = await http(edge.port, "/api/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: randomUUID(),
          name: "landing_visit",
          prompt: input.request,
        }),
      });
      assert.equal(invalidEvent.status, 400);
      const captures = JSON.stringify({
        application: seenLogs,
        proxy: edge.logs,
        analytics: (await pool.query("SELECT * FROM beta_events")).rows,
        runs: (await pool.query("SELECT * FROM beta_runs")).rows,
        calls: (await pool.query("SELECT * FROM beta_calls")).rows,
      });
      for (const value of [
        input.request,
        output,
        env.OPENAI_API_KEY,
        env.TURNSTILE_SECRET_KEY,
        env.IDENTITY_SECRET,
        db.url,
        cookie,
      ])
        assert(!captures.includes(value));
      assert(!response.text.includes(env.OPENAI_API_KEY));
    } finally {
      await edge.close();
    }
  });
