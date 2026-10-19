// Test worker only. Every model call is simulated; no real API key is accepted.
import { createServer } from "node:http";
import { Ledger, databasePool } from "../../ledger.mjs";
import { configuration } from "../../security.mjs";
import { benchmark } from "../../engine.mjs";
import { fakeProvider } from "../../fake-provider.mjs";
import { callProvider } from "../../provider.mjs";
import { webServer } from "../../server.mjs";

if (process.env.OPENAI_API_KEY !== "synthetic-staging-key-not-a-credential")
  process.exit(2);
const nativeFetch = globalThis.fetch;
globalThis.fetch = () => {
  throw new Error("External fetch forbidden by staging test.");
};
const config = configuration();
const pool = databasePool(config.databaseUrl);
const ledger = new Ledger(pool, config);
let web, sink, pending;
let calls = 0;
const report = (value) => process.send?.(value);
const logs =
  (kind) =>
  (...values) =>
    report({ type: "captured-log", kind, text: values.map(String).join(" ") });
console.log = logs("stdout");
console.error = logs("stderr");
const simulated = fakeProvider({ delayMs: 0 });

async function provider(args) {
  calls++;
  report({ type: "provider-called", calls });
  if (process.env.TEST_PROVIDER === "wait")
    return new Promise((resolve) => {
      pending = () => simulated(args).then(resolve);
    });
  if (process.env.TEST_PROVIDER === "timeout") {
    // Exercise the real provider adapter's 45-second timeout against a local
    // server that receives the request but never sends a response.
    return callProvider(args, (_url, options) =>
      nativeFetch(`http://127.0.0.1:${sink.address().port}/`, options),
    );
  }
  if (process.env.TEST_PROVIDER === "error")
    throw new Error(`${args.input.request} ${config.apiKey}`);
  return {
    ...(await simulated(args)),
    output: process.env.TEST_OUTPUT ?? "Synthetic staging answer.",
  };
}

process.on("message", async (message) => {
  try {
    if (message.action === "reserve") {
      const reservation = await ledger.reserve(message.args);
      return report({ type: "result", reservation });
    }
    if (message.action === "benchmark") {
      const reservation = await ledger.reserve(message.args);
      report({ type: "admitted", id: reservation.id });
      await benchmark({
        ledger,
        reservation,
        input: message.input,
        plan: message.args.plan,
        apiKey: config.apiKey,
        provider,
      });
      return report({ type: "result", calls });
    }
    if (message.action === "release") return pending?.();
    if (message.action === "stop") {
      web?.closeAllConnections();
      web?.close();
      sink?.closeAllConnections();
      sink?.close();
      await pool.end();
      process.exit(0);
    }
  } catch (error) {
    report({ type: "result", code: error.code ?? "unexpected", calls });
  }
});

if (process.env.TEST_PROVIDER === "timeout") {
  sink = createServer((req) => {
    req.resume();
  });
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
}
if (process.env.TEST_HTTP === "1") {
  web = webServer({ config, ledger, provider, verifier: async () => {} });
  await new Promise((resolve) => web.listen(config.port, "127.0.0.1", resolve));
}
report({ type: "ready" });
