import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import {
  stagingConfiguration,
  stagingFetch,
  stagingServer,
  stagingCommand,
} from "../staging.mjs";

const env = {
  STAGING_ONLY: "1",
  PUBLIC_ORIGIN: "https://staging.invalid",
  PORT: "10000",
  DATABASE_URL: "synthetic-database-placeholder",
  IDENTITY_SECRET: "synthetic-identity-".repeat(4),
  TURNSTILE_SITE_KEY: "synthetic-site-key",
  TURNSTILE_SECRET_KEY: "synthetic-turnstile-secret",
};

test("private staging rejects provider keys, demo security and any unpause request", () => {
  for (const override of [
    { STAGING_ONLY: "" },
    { OPENAI_API_KEY: "synthetic-key" },
    { BETA_MODE: "demo" },
    { BETA_KILL_SWITCH: "0" },
  ]) {
    assert.throws(() => stagingConfiguration({ ...env, ...override }));
  }
});

test("private staging remains paused with missing kill setting and no pricing approval", () => {
  const config = stagingConfiguration(env);
  assert.equal(config.mode, "live");
  assert.equal(config.allowed(), false);
  assert.equal(config.trusted.length, 0);
  assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
});

test("private staging blocks OpenAI and redirects but allows exact Siteverify transport", async () => {
  let attempts = 0;
  const transport = stagingFetch(async () => {
    attempts++;
    return new Response("{}");
  });
  for (const url of [
    "https://api.openai.com/v1/responses",
    "https://challenges.cloudflare.com/turnstile/v0/siteverify?redirect=1",
  ]) {
    assert.throws(() => transport(url, { method: "POST", redirect: "error" }));
  }
  assert.throws(() =>
    transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
    }),
  );
  assert.equal(attempts, 0);
  await transport("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    redirect: "error",
  });
  assert.equal(attempts, 1);
});

test("private staging refuses an enabled ledger or unavailable database", async () => {
  const config = stagingConfiguration(env);
  await assert.rejects(
    stagingServer(config, { status: async () => ({ killed: false }) }),
  );
  await assert.rejects(
    stagingServer(config, {
      status: async () => {
        throw new Error("synthetic outage");
      },
    }),
  );
});

test("private staging operator cannot resume, recover or reset accounting", async () => {
  let mutations = 0;
  const ledger = {
    switch: async (killed) => {
      assert.equal(killed, true);
      mutations++;
    },
  };
  for (const command of ["resume", "close-uncertain", "reset", "unknown"]) {
    await assert.rejects(stagingCommand(command, ledger));
  }
  assert.equal(mutations, 0);
  await stagingCommand("kill", ledger);
  assert.equal(mutations, 1);
});

test("private staging starts with canonical Host and rejects plans before any dispatch", async () => {
  const ledger = {
    status: async () => ({ killed: true }),
    throttle: async () => {},
  };
  const server = await stagingServer(stagingConfiguration(env), ledger);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const http = (path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: options.method ?? "GET",
          headers: { Host: "staging.invalid", ...options.headers },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    });
  try {
    assert.equal((await http("/healthz")).status, 200);
    assert.equal(
      (await http("/healthz", { headers: { Host: "forged.invalid" } })).status,
      403,
    );
    const cfg = await http("/api/config");
    const headers = {
      Origin: env.PUBLIC_ORIGIN,
      "Content-Type": "application/json",
      Cookie: cfg.headers["set-cookie"][0].split(";")[0],
      "X-CSRF-Token": JSON.parse(cfg.body).csrf,
    };
    const result = await http("/api/plan", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          model: "gpt-6-astra",
          system: "",
          request: "Synthetic request.",
          response: "",
        },
      }),
    });
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, "paused");
    assert(!result.body.includes("staging-fake-provider-only"));
    const submission = await http("/api/benchmark", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          model: "gpt-6-astra",
          system: "",
          request: "Synthetic request.",
          response: "",
        },
        idempotencyKey: "00000000-0000-4000-8000-000000000001",
        turnstileToken: "synthetic",
      }),
    });
    assert.equal(submission.status, 503);
    assert.equal(JSON.parse(submission.body).error.code, "paused");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
